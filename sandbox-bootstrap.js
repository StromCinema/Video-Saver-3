'use strict';

(() => {
  if (globalThis.lib && typeof globalThis.lib === 'object') {
    Object.assign(globalThis, globalThis.lib);
    return;
  }

  Object.defineProperty(globalThis, '__ytbdApplyLib', {
    configurable: true,
    value() {
      if (globalThis.lib && typeof globalThis.lib === 'object') {
        Object.assign(globalThis, globalThis.lib);
        return true;
      }
      return false;
    },
  });

  if (document && document.readyState !== 'loading') {
    globalThis.__ytbdApplyLib();
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      globalThis.__ytbdApplyLib();
    }, { once: true });
  }
})();
