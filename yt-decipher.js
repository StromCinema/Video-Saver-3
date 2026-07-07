'use strict';

(() => {
  const cache = new Map();

  function findMatchingBracket(source, startIndex, openChar, closeChar) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let i = startIndex; i < source.length; i += 1) {
      const ch = source[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === openChar) depth += 1;
      else if (ch === closeChar) {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function extractFunctionByName(source, name) {
    const escaped = name.replace(/[$]/g, '\\$&');
    const patterns = [
      new RegExp(`(?:var|let|const)\\s+${escaped}\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{`, 'm'),
      new RegExp(`${escaped}\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{`, 'm'),
      new RegExp(`function\\s+${escaped}\\s*\\(([^)]*)\\)\\s*\\{`, 'm'),
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      if (!match) continue;
      const braceStart = source.indexOf('{', match.index + match[0].length - 1);
      if (braceStart === -1) continue;
      const braceEnd = findMatchingBracket(source, braceStart, '{', '}');
      if (braceEnd === -1) continue;
      return {
        args: (match[1] || '').split(',').map((s) => s.trim()).filter(Boolean),
        body: source.slice(braceStart + 1, braceEnd),
        code: source.slice(match.index, braceEnd + 1),
      };
    }
    return null;
  }

  function extractObjectByName(source, name) {
    const escaped = name.replace(/[$]/g, '\\$&');
    const patterns = [
      new RegExp(`(?:var|let|const)\\s+${escaped}\\s*=\\s*\\{`, 'm'),
      new RegExp(`${escaped}\\s*=\\s*\\{`, 'm'),
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      if (!match) continue;
      const braceStart = source.indexOf('{', match.index + match[0].length - 1);
      if (braceStart === -1) continue;
      const braceEnd = findMatchingBracket(source, braceStart, '{', '}');
      if (braceEnd === -1) continue;
      return source.slice(braceStart, braceEnd + 1);
    }
    return null;
  }

  function extractSignatureFunctionName(playerCode) {
    const patterns = [
      /(?:signature|sig)\s*,\s*([A-Za-z0-9$]+)\(/,
      /\.sig\|\|([A-Za-z0-9$]+)\(/,
      /(?:^|[^\w$])([A-Za-z0-9$]{2,})\s*=\s*function\((\w+)\)\{\2=\2\.split\(""\)/,
      /function\s+([A-Za-z0-9$]{2,})\((\w+)\)\{\2=\2\.split\(""\)/,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(playerCode);
      if (match) return match[1];
    }
    return null;
  }

  function extractNFunctionRef(playerCode) {
    const patterns = [
      /\.get\("n"\)\)\s*&&\s*\([A-Za-z_$][\w$]*\s*=\s*([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\)/,
      /set\("n",\s*([A-Za-z_$][\w$]*)\(/,
      /([A-Za-z_$][\w$]{1,})\s*=\s*function\([A-Za-z_$][\w$]*\)\{[\s\S]{0,700}?join\(""\)[\s\S]{0,120}?\}/,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(playerCode);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  function splitStatements(body) {
    const parts = [];
    let start = 0;
    let depthParen = 0;
    let depthBrace = 0;
    let depthBracket = 0;
    let quote = null;
    let escaped = false;
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(') depthParen += 1;
      else if (ch === ')') depthParen -= 1;
      else if (ch === '{') depthBrace += 1;
      else if (ch === '}') depthBrace -= 1;
      else if (ch === '[') depthBracket += 1;
      else if (ch === ']') depthBracket -= 1;
      else if (ch === ';' && !depthParen && !depthBrace && !depthBracket) {
        const stmt = body.slice(start, i).trim();
        if (stmt) parts.push(stmt);
        start = i + 1;
      }
    }
    const tail = body.slice(start).trim();
    if (tail) parts.push(tail);
    return parts;
  }

  function parseObjectMethods(objectCode) {
    if (!objectCode) return {};
    const methods = {};
    const body = objectCode.slice(1, -1);
    let idx = 0;
    while (idx < body.length) {
      const propMatch = /\s*([A-Za-z0-9$]+)\s*:\s*function\s*\(([^)]*)\)\s*\{/.exec(body.slice(idx));
      if (!propMatch) break;
      idx += propMatch.index;
      const name = propMatch[1];
      const args = propMatch[2].split(',').map((s) => s.trim()).filter(Boolean);
      const relBraceStart = body.indexOf('{', idx + propMatch[0].length - 1);
      const braceEnd = findMatchingBracket(body, relBraceStart, '{', '}');
      if (relBraceStart === -1 || braceEnd === -1) break;
      const fnBody = body.slice(relBraceStart + 1, braceEnd);
      methods[name] = classifyMethod(args, fnBody);
      idx = braceEnd + 1;
      const comma = body.indexOf(',', idx);
      if (comma === idx) idx += 1;
    }
    return methods;
  }

  function classifyMethod(args, body) {
    const compact = body.replace(/\s+/g, ' ');
    if (/\.reverse\(\)/.test(compact)) return { type: 'reverse' };
    if (/\.splice\(0,/.test(compact)) return { type: 'splice', argIndex: 1 };
    if (/\.slice\(/.test(compact)) return { type: 'slice', argIndex: 1 };
    if (/var\s+\w+=\w+\[0\];\w+\[0\]=\w+\[\w+%\w+\.length\];\w+\[\w+\]=\w+/.test(compact)
      || /\w+\[0\]=\w+\[\w+%\w+\.length\]/.test(compact)) {
      return { type: 'swap', argIndex: 1 };
    }
    return { type: 'unknown', body: compact, args };
  }

  function parsePlan(playerCode, refName) {
    if (!refName) return null;
    const fn = extractFunctionByName(playerCode, refName);
    if (!fn) return null;
    const helperNames = Array.from(new Set(
      Array.from(fn.body.matchAll(/([A-Za-z0-9$]{2,})\.([A-Za-z0-9$]{2,})\(/g)).map((m) => m[1]),
    ));
    const helpers = {};
    for (const helperName of helperNames) {
      const objectCode = extractObjectByName(playerCode, helperName);
      if (objectCode) helpers[helperName] = parseObjectMethods(objectCode);
    }
    return { refName, fn, helpers };
  }

  function toNumber(token, vars) {
    if (token == null) return 0;
    const clean = String(token).trim();
    if (/^-?\d+$/.test(clean)) return parseInt(clean, 10);
    if (clean in vars) return Number(vars[clean]) || 0;
    return 0;
  }

  function applyHelperOp(op, arr, val) {
    if (!op) return arr;
    const n = Number(val) || 0;
    switch (op.type) {
      case 'reverse':
        arr.reverse();
        return arr;
      case 'splice':
        arr.splice(0, n);
        return arr;
      case 'slice':
        return arr.slice(n);
      case 'swap': {
        if (!arr.length) return arr;
        const idx = ((n % arr.length) + arr.length) % arr.length;
        const tmp = arr[0];
        arr[0] = arr[idx];
        arr[idx] = tmp;
        return arr;
      }
      default:
        throw new Error(`Unsupported helper op: ${op.type || 'unknown'}`);
    }
  }

  function executePlan(plan, input) {
    if (!plan?.fn) throw new Error('Missing transform plan');
    const argName = plan.fn.args[0] || 'a';
    const vars = { [argName]: input };
    let current = input;
    const statements = splitStatements(plan.fn.body);
    for (const stmt of statements) {
      if (/^return\b/.test(stmt)) {
        const expr = stmt.replace(/^return\s+/, '').trim();
        if (expr === argName || expr === '"".join(' + argName + ')') return current;
        if (expr === `${argName}.join("")` || expr === `${argName}.join('')`) {
          return Array.isArray(current) ? current.join('') : String(current);
        }
        if (expr === `${argName}.slice(0)`) {
          current = Array.isArray(current) ? current.slice(0) : String(current);
          return current;
        }
        if (expr === `${argName}.length`) return String(current).length;
      }

      if (new RegExp(`^(?:var\\s+)?${argName}\\s*=\\s*${argName}\\.split\\((?:""|'')\\)$`).test(stmt)) {
        current = String(current).split('');
        vars[argName] = current;
        continue;
      }
      if (new RegExp(`^(?:var\\s+)?${argName}\\s*=\\s*${argName}\\.join\\((?:""|'')\\)$`).test(stmt)) {
        current = Array.isArray(current) ? current.join('') : String(current);
        vars[argName] = current;
        continue;
      }
      if (new RegExp(`^(?:var\\s+)?${argName}\\s*=\\s*${argName}\\.slice\\(([^)]+)\\)$`).test(stmt)) {
        const m = stmt.match(new RegExp(`^(?:var\\s+)?${argName}\\s*=\\s*${argName}\\.slice\\(([^)]+)\\)$`));
        current = (Array.isArray(current) ? current : String(current).split('')).slice(toNumber(m[1], vars));
        vars[argName] = current;
        continue;
      }
      if (new RegExp(`^${argName}\\.reverse\\(\\)$`).test(stmt)) {
        current = Array.isArray(current) ? current : String(current).split('');
        current.reverse();
        vars[argName] = current;
        continue;
      }
      if (new RegExp(`^${argName}\\.splice\\(0,([^\)]+)\\)$`).test(stmt)) {
        const m = stmt.match(new RegExp(`^${argName}\\.splice\\(0,([^\)]+)\\)$`));
        current = Array.isArray(current) ? current : String(current).split('');
        current.splice(0, toNumber(m[1], vars));
        vars[argName] = current;
        continue;
      }

      const helperCall = stmt.match(new RegExp(`^(?:${argName}\\s*=\\s*)?([A-Za-z0-9$]{2,})\\.([A-Za-z0-9$]{2,})\\(${argName}(?:,([^\)]*))?\\)$`));
      if (helperCall) {
        const helperName = helperCall[1];
        const methodName = helperCall[2];
        const rawVal = helperCall[3];
        const op = plan.helpers?.[helperName]?.[methodName];
        current = Array.isArray(current) ? current : String(current).split('');
        current = applyHelperOp(op, current, toNumber(rawVal, vars));
        vars[argName] = current;
        continue;
      }

      if (/^if\s*\(/.test(stmt) || /^try\b/.test(stmt) || /^catch\b/.test(stmt) || /^else\b/.test(stmt)) {
        continue;
      }

      // Ignore assignments to temp vars and benign guards.
      if (/^(?:var\s+)?[A-Za-z_$][\w$]*\s*=/.test(stmt)) continue;
    }

    return Array.isArray(current) ? current.join('') : String(current);
  }

  function getPlans(playerCode) {
    if (cache.has(playerCode)) return cache.get(playerCode);
    const plans = {
      signature: parsePlan(playerCode, extractSignatureFunctionName(playerCode)),
      n: parsePlan(playerCode, extractNFunctionRef(playerCode)),
    };
    cache.set(playerCode, plans);
    return plans;
  }

  function decipherSignature(playerCode, s) {
    const plans = getPlans(playerCode);
    if (!plans.signature) throw new Error('Signature transform not found');
    return executePlan(plans.signature, s);
  }

  function transformN(playerCode, n) {
    const plans = getPlans(playerCode);
    if (!plans.n) throw new Error('n transform not found');
    return executePlan(plans.n, n);
  }

  globalThis.YTBDDecipher = {
    findMatchingBracket,
    extractFunctionByName,
    extractObjectByName,
    extractSignatureFunctionName,
    extractNFunctionRef,
    getPlans,
    decipherSignature,
    transformN,
  };
})();
