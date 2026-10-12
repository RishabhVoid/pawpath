import { useEffect, useState, type CSSProperties } from 'react';
import { resolveSpecies, type Outfit, type PlayerProfile, type Species } from '../../shared/types.js';
import { previewCreatures } from './pets-preview-data.js';
import { PixelCreature } from './PixelCreature.js';
import { accessoryForItem } from './ItemArt.js';

export function PetArt({ species = 'pip', small = false, tone, expression = 'idle', walking = false, equipped = {} }: { species?: Species; small?: boolean; tone?: PlayerProfile['tone']; expression?: 'idle' | 'happy' | 'sad'; walking?: boolean; equipped?: Outfit }) {
  const [tick, setTick] = useState(0);
  const pet = previewCreatures.find(pet => pet.id === resolveSpecies(species))!;
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: number | undefined;
    const update = () => { window.clearInterval(timer); if (!preference.matches) timer = window.setInterval(() => setTick(value => value + 1), 320); };
    update(); preference.addEventListener('change', update);
    return () => { window.clearInterval(timer); preference.removeEventListener('change', update); };
  }, []);
  const frame = expression === 'sad' ? 3 : walking ? tick % 2 ? 2 : 0 : expression === 'happy' || tick % 28 === 27 ? 1 : 0;
  const outfits = [...new Set(Object.values(equipped).map(id => accessoryForItem[id]).filter(Boolean))];
  return <div role="img" aria-label={`${expression === 'sad' ? 'Wistful' : walking ? 'Walking' : 'Your'} ${pet.kind} companion`} data-tone={tone} style={{ '--pet-ratio': pet.frames[frame][2] / pet.frames[frame][3] } as CSSProperties} className={`pet-art pose-${walking ? 'walking' : expression}${small ? ' small' : ''}${pet.flying ? ' is-flying' : ''}`}><PixelCreature pet={pet} frame={frame} outfits={outfits}/></div>;
}
