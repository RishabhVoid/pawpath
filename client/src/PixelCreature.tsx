import { useId } from 'react';
import type { PreviewAccessory, PreviewCreature } from './pets-preview-data.js';

export function Accessory({ item }: { item: PreviewAccessory }) {
  if (item === 'bandana') return <g><path fill="#cf877b" d="M-6 0H6v3H3v3H0v3h-3V6h-3z" /><path fill="#e6aa91" d="M-6 0H6v2H-6z" /></g>;
  if (item === 'bell') return <g><path fill="#5c7770" d="M-6 0H6v2H-6z" /><path fill="#d8bd78" d="M-2 2h4v2h2v4h-8V4h2z" /><path fill="#655c46" d="M-1 6h2v3h-2z" /></g>;
  if (item === 'leaf') return <g><path fill="#91a86c" d="M-6-4h4v-2h8v6H4v2H-4V0h-2z" /><path fill="#455f50" d="M-4 0H6v2H-4z" /><path fill="#c1ce92" d="M-2-4H4v2h-6z" /></g>;
  if (item === 'scarf') return <g><path fill="#a2bacb" d="M-6 0H6v4H2v8h-4V4h-4z" /><path fill="#617d91" d="M-6 2H6v2H-6zM-2 8h4v2h-4z" /></g>;
  return <g><path fill="#dfc481" d="M-1-4h2v3h3v2H1v3h-2V1h-3v-2h3z" /><path fill="#fae4ad" d="M-1-1h2v2h-2z" /></g>;
}

export function PixelCreature({ pet, frame = 0, outfit, outfits = [] }: { pet: PreviewCreature; frame?: number; outfit?: PreviewAccessory; outfits?: PreviewAccessory[] }) {
  const cropId = useId();
  const bounds = pet.frames[frame];
  const droop = frame === 3 ? 5 : 0;
  return <span className="study-creature-art" aria-hidden="true"><svg className="study-creature" viewBox="0 0 64 64" shapeRendering="crispEdges">
    <svg width="64" height="64" viewBox={pet.frames[frame].join(' ')} preserveAspectRatio="xMidYMax meet" overflow="hidden">
      <defs><clipPath id={cropId}><rect x={bounds[0]} y={bounds[1]} width={bounds[2]} height={bounds[3]} /></clipPath></defs>
      <image href={`/art/pets-preview/${pet.file}.webp`} width={pet.size[0]} height={pet.size[1]} clipPath={`url(#${cropId})`} />
    </svg>
    {[...outfits, ...(outfit ? [outfit] : [])].map(item => { const anchor = item === 'leaf' ? pet.head : pet.neck; return <g key={item} transform={`translate(${anchor[0]} ${anchor[1] + droop})`}><Accessory item={item} /></g>; })}
  </svg></span>;
}

