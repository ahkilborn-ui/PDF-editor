// Offline / install support for the installable app (copied into app/ by
// tools/build-offline.mjs). Registers the service worker that stores the app
// on this computer, and shows an "Install app" button.
(() => {
  'use strict';

  const btn = document.getElementById('install-btn');
  const status = document.getElementById('status');
  const ua = navigator.userAgent;
  const isSafari = /Safari\//.test(ua) && !/Chrome|Chromium|Edg\/|OPR\//.test(ua);
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let prompt = null;

  function idleStatus(msg) {
    // Don't overwrite messages about an open document.
    if (!document.body.classList.contains('has-doc')) status.textContent = msg;
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    if (!navigator.serviceWorker.controller) idleStatus('Saving the app on this computer for offline use…');
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Offline support unavailable:', err);
      idleStatus('Offline support isn\'t available in this browser.');
    });
    navigator.serviceWorker.ready.then(() => idleStatus('Ready — works offline.'));
  }

  // Chrome and Edge offer installing through this event.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    prompt = e;
    btn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    prompt = null;
  });

  // Safari has no install event; show the button with instructions instead.
  if (isSafari && !installed) btn.hidden = false;

  btn.addEventListener('click', async () => {
    if (prompt) {
      prompt.prompt();
      await prompt.userChoice;
      prompt = null;
      btn.hidden = true;
    } else if (isSafari) {
      alert('To install: in the Safari menu bar choose File → Add to Dock.\n\n' +
        'PDF Editor then opens from the Dock or Launchpad like any other app, and works offline.');
    }
  });
})();
