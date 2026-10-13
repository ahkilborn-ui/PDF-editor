// Offline / install support for the installable app (copied into app/ by
// tools/build-offline.mjs). Registers the service worker that stores the app
// on this computer, and runs the "Install app" button.
(() => {
  'use strict';

  const btn = document.getElementById('install-btn');
  const status = document.getElementById('status');
  const ua = navigator.userAgent;
  const isEdge = /Edg\//.test(ua);
  const isChromium = /Chrome\/|Chromium\//.test(ua);
  const isFirefox = /Firefox\//.test(ua);
  const isSafari = /Safari\//.test(ua) && !isChromium;
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function idleStatus(msg) {
    // Don't overwrite messages about an open document.
    if (!document.body.classList.contains('has-doc')) status.textContent = msg;
  }

  function notice(title, message) {
    if (window.pdfEditor?.notice) window.pdfEditor.notice(title, message);
    else alert(`${title}\n\n${message}`);
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    if (!navigator.serviceWorker.controller) idleStatus('Saving the app on this computer for offline use…');
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Offline support unavailable:', err);
      idleStatus('Offline support isn\'t available in this browser.');
    });
    navigator.serviceWorker.ready.then(() => idleStatus('Ready — works offline.'));
  }

  // Already running as the installed app: nothing to install.
  if (installed) return;
  btn.hidden = false;

  // Chrome and Edge offer installing through this event. It can arrive before
  // this script runs, so a tiny script at the top of the page catches it
  // first (window.__installPrompt).
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__installPrompt = e;
  });
  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    window.__installPrompt = null;
    idleStatus('Installed. Open PDF Editor from your apps (Start menu, Dock or Launchpad).');
  });

  btn.addEventListener('click', async () => {
    const prompt = window.__installPrompt;
    if (prompt) {
      window.__installPrompt = null; // each offer can only be used once
      prompt.prompt();
      const { outcome } = await prompt.userChoice;
      if (outcome === 'accepted') btn.hidden = true;
      return;
    }
    if (isSafari) {
      notice('Install PDF Editor', 'In the Safari menu bar choose File → Add to Dock. ' +
        'PDF Editor then opens from the Dock or Launchpad like any other app, and works offline.');
    } else if (isFirefox) {
      notice('Install PDF Editor', 'Firefox can\'t install web apps. To install PDF Editor, open this page in Chrome or Edge ' +
        'and click Install app there. You can keep using it here in Firefox, and this page keeps working without internet once it has loaded.');
    } else if (isEdge) {
      notice('Install PDF Editor', 'If PDF Editor is already installed, open it from the Start menu (Windows) or Launchpad (Mac). ' +
        'Otherwise, click the app icon at the right end of the address bar, or open the ⋯ menu → Apps → Install this site as an app.');
    } else if (isChromium) {
      notice('Install PDF Editor', 'If PDF Editor is already installed, open it from the Start menu (Windows) or Launchpad (Mac). ' +
        'Otherwise, click the install icon at the right end of the address bar, or open the ⋮ menu → Cast, save and share → Install page as app.');
    } else {
      notice('Install PDF Editor', 'To install PDF Editor as an app, open this page in Chrome or Edge and click Install app there.');
    }
  });
})();
