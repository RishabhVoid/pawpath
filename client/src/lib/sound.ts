import { resolveSpecies, species as collection, type Species } from '../../../shared/types.js';

let context: AudioContext | undefined;
export function chirp(species: Species = 'pip', words = 3) {
  if (localStorage.getItem('pawpath.muted') === 'true') return;
  context ||= new AudioContext();
  void context.resume();
  const pitch = 240 + collection.indexOf(resolveSpecies(species)) * 45;
  for (let i = 0; i < Math.min(12, words); i++) {
    const oscillator = context.createOscillator(), gain = context.createGain(), start = context.currentTime + i * 0.085;
    oscillator.type = 'sine'; oscillator.frequency.value = pitch + (i % 3) * 65;
    gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.06, start + 0.01); gain.gain.exponentialRampToValueAtTime(0.001, start + 0.06);
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(start); oscillator.stop(start + 0.07);
  }
}
