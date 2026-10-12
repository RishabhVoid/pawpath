import type { PlayerProfile } from '../../../shared/types.js';

export class ApiError extends Error {
  constructor(message: string, public status: number, public reason?: string, public suggestMode?: string) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('pawpath.token');
  let response: Response;
  try { response = await fetch('/api' + path, { ...options, signal: options.signal || AbortSignal.timeout(path.includes('vision') ? 65_000 : 30_000), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...options.headers } }); }
  catch { throw new ApiError('Pawpath is waking up. Check your connection and try again.', 503); }
  let data;
  try { data = await response.json(); }
  catch { throw new ApiError('Pawpath is waking up. Check your connection and try again.', 503); }
  if (!response.ok) throw new ApiError(data.message || 'Something went wrong. Please try again.', response.status, data.reason, data.suggestMode);
  return data as T;
}
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export async function ensureAccount() {
  if (!localStorage.getItem('pawpath.token')) return null;
  return api<{ username: string | null; friendCode: string; profile: PlayerProfile | null }>('/me');
}
