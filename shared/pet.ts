import { resolveSpecies, type Pet } from './types.js';

export const clamp = (n: number, min = 0, max = 100) => Math.min(max, Math.max(min, n));
export const levelFor = (xp: number) => Math.floor(Math.sqrt(xp / 100)) + 1;
export const nextLevelXp = (level: number) => level * level * 100;
export function currentPet(pet: Pet, now = Date.now()): Pet {
  const hours = Math.max(0, now - pet.updatedAt) / 3_600_000;
  return { ...pet, species: resolveSpecies(pet.species), hunger: clamp(pet.hunger - hours * 2), energy: clamp(pet.energy + hours * 4), mood: pet.lastWalkAt && now - pet.lastWalkAt > 48 * 3_600_000 ? Math.min(pet.mood, 35) : pet.mood, level: levelFor(pet.xp) };
}
export function walkReward(distanceM: number) {
  const xp = Math.floor(distanceM / 10);
  return { xp, food: xp > 0 ? distanceM / 25 : 0 };
}
export function distanceBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
export const geoCell = (lat: number, lon: number) => `${(Math.round(lat / 0.0015) * 0.0015).toFixed(4)},${(Math.round(lon / 0.0015) * 0.0015).toFixed(4)}`;
export const shortLine = (line: string) => line.replace(/<think>[\s\S]*?<\/think>/g, '').trim().split(/\s+/).slice(0, 24).join(' ');
