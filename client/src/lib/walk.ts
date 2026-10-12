import { distanceBetween, geoCell } from '../../../shared/pet.js';

export type Fix = { lat: number; lon: number; accuracy: number; timestamp: number };
export function acceptedStep(previous: Fix | null, next: Fix): { point: Fix | null; meters: number } {
  if (!Number.isFinite(next.lat) || !Number.isFinite(next.lon) || next.accuracy > 40 || next.accuracy < 0) return { point: previous, meters: 0 };
  if (!previous) return { point: next, meters: 0 };
  const seconds = (next.timestamp - previous.timestamp) / 1000;
  if (seconds <= 0) return { point: previous, meters: 0 };
  if (seconds > 45) return { point: next, meters: 0 };
  const meters = distanceBetween(previous, next);
  if (meters / seconds > 4 || meters < Math.max(4, Math.min(previous.accuracy, next.accuracy) / 2)) return { point: previous, meters: 0 };
  return { point: next, meters };
}
export function watchWalk(onStep: (meters: number, cell: string) => void, onError: (message: string) => void, geolocation: Geolocation | undefined = navigator.geolocation, visibility = document) {
  if (!geolocation) { onError('Distance tracking needs a secure HTTPS address and location access.'); return () => {}; }
  let previous: Fix | null = null;
  const reset = () => { previous = null; };
  visibility.addEventListener('visibilitychange', reset);
  const id = geolocation.watchPosition(position => {
    if (visibility.hidden) { previous = null; return; }
    const next = { lat: position.coords.latitude, lon: position.coords.longitude, accuracy: position.coords.accuracy, timestamp: position.timestamp };
    const accepted = acceptedStep(previous, next);
    previous = accepted.point;
    if (accepted.point === next) onStep(accepted.meters, geoCell(next.lat, next.lon));
  }, error => onError(error.code === 1 ? 'Allow location access to track your walk.' : 'Waiting for a clearer GPS signal. Your walk timer is still running.'), { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
  return () => { geolocation.clearWatch(id); visibility.removeEventListener('visibilitychange', reset); };
}
export function keepWalkAwake(onState: (awake: boolean) => void, wakeLock = navigator.wakeLock, visibility = document) {
  let active = true, requesting = false, lock: WakeLockSentinel | undefined;
  const request = async () => {
    if (!active || requesting || visibility.hidden || (lock && !lock.released)) return;
    requesting = true;
    try {
      const next = await wakeLock?.request('screen');
      if (!active) { void next?.release(); return; }
      lock = next; onState(Boolean(next));
      next?.addEventListener('release', () => { if (active && lock === next) onState(false); });
    } catch { if (active) onState(false); }
    finally { requesting = false; }
  };
  visibility.addEventListener('visibilitychange', request);
  void request();
  return () => { active = false; visibility.removeEventListener('visibilitychange', request); void lock?.release(); onState(false); };
}
export function locate(geolocation: Geolocation | undefined = navigator.geolocation, secure = globalThis.isSecureContext): Promise<GeolocationPosition> {
  if (secure === false) return Promise.reject(new Error('Phone location needs HTTPS. This local HTTP link can connect your account, but cannot start tracking. Open Pawpath at its HTTPS address.'));
  if (!geolocation) return Promise.reject(new Error('Location is unavailable in this browser. Open this page in Safari or Chrome and try again.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message: string) => { if (settled) return; settled = true; clearTimeout(timer); reject(new Error(message)); };
    const timer = setTimeout(() => fail('Location did not respond. Check the browser’s location permission and your phone’s Location Services, then try again.'), 20_000);
    try {
      geolocation.getCurrentPosition(position => { if (settled) return; settled = true; clearTimeout(timer); resolve(position); }, error => fail(error.code === 1 ? 'Location is blocked. Allow location for this site in your browser settings and enable your phone’s Location Services, then try again.' : error.code === 2 ? 'Your phone could not find its location. Enable Location Services, move somewhere with a clearer signal, and try again.' : 'GPS took too long. Move somewhere with a clearer signal and try again.'), { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 });
    } catch { fail('Location could not open. Use Safari or Chrome, allow this site to use location, and try again.'); }
  });
}
