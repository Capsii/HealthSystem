const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const scriptPath = path.join(__dirname, '..', 'public', 'js', 'sw-register.js');
const script = fs.readFileSync(scriptPath, 'utf8');
const dismissalKey = 'healthsys-install-prompt-dismissed';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.removed = false;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  append(...elements) {
    this.children.push(...elements);
  }

  prepend(element) {
    this.children.unshift(element);
    element.parent = this;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  remove() {
    this.removed = true;
    if (this.parent) {
      this.parent.children = this.parent.children.filter(
        (element) => element !== this,
      );
    }
  }

  click() {
    this.listeners.get('click')?.();
  }
}

function makePage(pathname, storage = new Map()) {
  const windowListeners = new Map();
  const main = new FakeElement('main');
  const body = new FakeElement('body');
  const window = {
    location: { hostname: 'healthsys.example', pathname },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    matchMedia: () => ({ matches: false }),
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
  };
  const document = {
    readyState: 'loading',
    body,
    createElement: (tagName) => new FakeElement(tagName),
    querySelector: (selector) => (selector === 'main' ? main : null),
    addEventListener() {},
  };

  vm.runInNewContext(
    script,
    {
      document,
      window,
      navigator: { standalone: false },
      location: window.location,
      console: { info() {} },
      Promise,
    },
    { filename: 'sw-register.js' },
  );

  function dispatchInstallability() {
    windowListeners.get('beforeinstallprompt')?.({
      preventDefault() {},
      prompt() {},
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
  }

  function installNotice() {
    return main.children.find(
      (element) => element.attributes.get('aria-label') === 'Install HealthSys',
    );
  }

  return { main, storage, dispatchInstallability, installNotice };
}

test('install prompt is eligibility-gated and limited to login', () => {
  const dashboard = makePage('/dashboard');
  dashboard.dispatchInstallability();
  assert.equal(dashboard.installNotice(), undefined);

  const unsupportedLogin = makePage('/login');
  assert.equal(unsupportedLogin.installNotice(), undefined);
});

test('Later dismisses the install prompt for this login session only', () => {
  const sessionStorage = new Map();
  const login = makePage('/login', sessionStorage);
  login.dispatchInstallability();

  const notice = login.installNotice();
  assert.ok(notice);
  const later = notice.children.find(
    (element) => element.textContent === 'Later',
  );
  assert.ok(later);
  later.click();
  assert.equal(login.installNotice(), undefined);
  assert.equal(sessionStorage.get(dismissalKey), 'true');

  const refreshedLogin = makePage('/login', sessionStorage);
  refreshedLogin.dispatchInstallability();
  assert.equal(refreshedLogin.installNotice(), undefined);

  const nextLoginSession = makePage('/login', new Map());
  nextLoginSession.dispatchInstallability();
  assert.ok(nextLoginSession.installNotice());
});

test('logout clears the session-scoped install prompt dismissal', () => {
  const uiScript = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'ui.js'),
    'utf8',
  );
  assert.match(
    uiScript,
    /sessionStorage\.removeItem\(\s*INSTALL_PROMPT_DISMISSED_KEY\s*\)/,
  );
});
