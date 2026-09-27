// Web push i browseren: understøttelse, tilladelse, abonnement og lokal testbesked.
import { VAPID_PUBLIC_KEY } from './firebase-config.js';

export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/.test(navigator.userAgent);
export const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
export const deviceLabel = () => isIOS ? 'iPhone/iPad' : isAndroid ? 'Android' : 'Computer';

/** 'ok' | 'ios-browser' (iPhone i almindelig Safari-fane) | 'insecure' | 'unsupported' | 'denied' */
export function pushSupport() {
  if (isIOS && !isStandalone()) return 'ios-browser';
  if (!window.isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  return navigator.serviceWorker.register('sw.js').catch(e => { console.warn('service worker', e); return null; });
}

function keyBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

/** Bed om tilladelse og abonnér. Returnerer {endpoint, keys:{p256dh, auth}}. */
export async function subscribePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw Object.assign(new Error('Tilladelse blev ikke givet'), { code: perm === 'denied' ? 'denied' : 'dismissed' });
  await registerServiceWorker();
  const reg = await navigator.serviceWorker.ready;
  const opts = { userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) };
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    const cur = sub.options?.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey)));
    const want = btoa(String.fromCharCode(...keyBytes(VAPID_PUBLIC_KEY)));
    if (cur && cur !== want) { await sub.unsubscribe(); sub = null; }   // gammel nøgle
  }
  if (!sub) sub = await reg.pushManager.subscribe(opts);
  const j = sub.toJSON();
  return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } };
}

/** Vis en lokal notifikation med det samme (beviser at tilladelse + service worker virker). */
export async function localNotification(title, body, url) {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification(title, { body, icon: 'icon-192.png', badge: 'icon-192.png', lang: 'da', tag: 'sg-local-test', data: { url } });
}
