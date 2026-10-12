import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, CloudRain, Footprints, Grid3X3, Heart, Moon, Sparkles, Sun, X } from 'lucide-react';
import { previewAccessories, previewCreatures, type PreviewAccessory } from './pets-preview-data.js';
import './pets-preview.css';
import { Accessory, PixelCreature } from './PixelCreature.js';

type Pose = 'idle' | 'walk' | 'sad';

export default function PetsPreview() {
  const [selected, setSelected] = useState(0);
  const [pose, setPose] = useState<Pose>('idle');
  const [tick, setTick] = useState(0);
  const [rain, setRain] = useState(true);
  const [outfit, setOutfit] = useState<PreviewAccessory>();
  const [greeting, setGreeting] = useState(false);
  const [drawer, setDrawer] = useState<'pets' | 'outfits' | null>(null);
  const guide = useRef<HTMLDialogElement>(null);
  const pet = previewCreatures[selected];
  const frame = pose === 'sad' ? 3 : pose === 'walk' ? (tick % 2 ? 2 : 0) : greeting || tick % 28 === 27 ? 1 : 0;

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: number | undefined;
    const update = () => {
      window.clearInterval(timer);
      if (!preference.matches) timer = window.setInterval(() => setTick(value => value + 1), 320);
    };
    update();
    preference.addEventListener('change', update);
    return () => { window.clearInterval(timer); preference.removeEventListener('change', update); };
  }, []);
  useEffect(() => {
    if (drawer && !guide.current?.open) guide.current?.showModal();
    if (!drawer && guide.current?.open) guide.current.close();
  }, [drawer]);
  useEffect(() => {
    if (!greeting) return;
    const timer = window.setTimeout(() => setGreeting(false), 1800);
    return () => window.clearTimeout(timer);
  }, [greeting]);

  function choosePet(index: number) {
    setSelected((index + previewCreatures.length) % previewCreatures.length);
    setGreeting(false);
  }

  return <main className={`pets-study ${rain ? 'is-raining' : 'is-clear'}`} style={{ '--study-accent': pet.color } as CSSProperties}>
    <div className="study-world" aria-hidden="true" />
    <div className="study-rain" aria-hidden="true">{Array.from({ length: 22 }, (_, index) => <i key={index} style={{ left: `${(index * 37) % 101}%`, animationDelay: `${-(index % 9) * 0.19}s`, animationDuration: `${1.2 + index % 4 * 0.15}s` }} />)}</div>
    <header className="study-header">
      <a className="study-brand" href="/" aria-label="Back to Pawpath"><span className="study-brand-mark">✦</span> pawpath<span className="study-preview-label">PET SHELTER / 03</span></a>
      <button className="study-weather" onClick={() => setRain(value => !value)} aria-label={rain ? 'Turn rain off' : 'Turn rain on'} aria-pressed={rain}>{rain ? <CloudRain size={17} /> : <Sun size={17} />}<span>{rain ? 'Soft rain' : 'Clear skies'}</span></button>
    </header>
    <div className="study-intro"><span className="study-eyebrow">TEN LITTLE WANDERERS</span><h1>Find your<br />walking buddy.</h1></div>
    <div className="study-habitat" aria-hidden="true"><span className="study-orbit" /><span className="study-ledge" /><span className="study-plant" /><span className="study-plant second" /></div>
    <div className={`study-pet-position ${pet.flying ? 'is-flying' : ''}`}>
      <div className={`study-pet-motion pose-${pose}`}>
        <span className="study-pet-shadow" aria-hidden="true" />
        <button className={`study-pet-touch ${greeting ? 'is-greeting' : ''}`} aria-label={`Pet ${pet.name}`} onClick={() => setGreeting(true)}>
          <PixelCreature pet={pet} frame={frame} outfit={outfit} />
          {greeting && <span className="study-affection" aria-hidden="true">♥</span>}
        </button>
      </div>
      <div className="study-pet-caption" aria-live="polite"><span className="study-species">{pet.kind}</span><span className="study-pet-name">{pet.name}</span><span>{greeting ? '♥' : pose === 'sad' ? 'A little company?' : 'Tap to say hello'}</span></div>
    </div>
    <section className="study-dock" aria-label="Pet design controls">
      <div className="study-switcher" role="group" aria-label="Choose a companion">
        <button className="study-cycle" aria-label="Previous companion" onClick={() => choosePet(selected - 1)}><ChevronLeft size={17} /></button>
        <button className="study-open-guide" onClick={() => setDrawer('pets')} aria-haspopup="dialog"><PixelCreature pet={pet} /><span><strong>{pet.name}</strong><span><Grid3X3 size={12} />Meet all 10</span></span></button>
        <button className="study-cycle" aria-label="Next companion" onClick={() => choosePet(selected + 1)}><ChevronRight size={17} /></button>
      </div>
      <div className="study-controls">
        <div className="study-poses" role="group" aria-label="Try an expression">
          <button aria-pressed={pose === 'idle'} onClick={() => setPose('idle')}><Moon size={15} />Idle</button>
          <button aria-pressed={pose === 'walk'} onClick={() => setPose('walk')}><Footprints size={15} />Move</button>
          <button aria-pressed={pose === 'sad'} onClick={() => setPose('sad')}><Heart size={15} />Sad</button>
        </div>
        <button className="study-outfit" aria-haspopup="dialog" onClick={() => setDrawer('outfits')}><Sparkles size={15} /><span>{outfit ? previewAccessories.find(item => item.id === outfit)?.name : 'Dress up'}</span><span className="study-item-count">5 ITEMS</span></button>
      </div>
    </section>
    <dialog className="study-guide" ref={guide} aria-labelledby="study-guide-title" onClose={() => setDrawer(null)}>
      {drawer && <>
        <div className="study-guide-heading"><div><span className="study-eyebrow">{drawer === 'pets' ? 'THE LITTLE FIELD GUIDE' : 'FIVE LITTLE FINDS'}</span><h2 id="study-guide-title">{drawer === 'pets' ? 'Pick your companion.' : 'A little something.'}</h2></div><button className="study-guide-close" autoFocus aria-label="Close preview drawer" onClick={() => setDrawer(null)}><X size={21} /></button></div>
        <div className={`study-guide-grid ${drawer === 'outfits' ? 'is-outfits' : ''}`}>
          {drawer === 'pets' ? previewCreatures.map((creature, index) => <button key={creature.id} className={`study-guide-creature ${creature.id === pet.id ? 'is-selected' : ''}`} aria-pressed={creature.id === pet.id} style={{ '--choice-color': creature.color } as CSSProperties} onClick={() => { choosePet(index); setDrawer(null); }}><PixelCreature pet={creature} /><strong>{creature.name}</strong><span>{creature.kind}</span></button>) : previewAccessories.map(item => <button key={item.id} className={`study-guide-creature ${outfit === item.id ? 'is-selected' : ''}`} aria-pressed={outfit === item.id} style={{ '--choice-color': pet.color } as CSSProperties} onClick={() => { setOutfit(outfit === item.id ? undefined : item.id); setDrawer(null); }}><svg className="study-item-art" viewBox="-12 -12 24 28" shapeRendering="crispEdges" aria-hidden="true"><Accessory item={item.id} /></svg><strong>{item.name}</strong><span>{outfit === item.id ? 'Take off' : 'Try on'}</span></button>)}
        </div>
        <div className="study-guide-footer"><span>{drawer === 'pets' ? '10 original creatures' : 'One item at a time · tap again to remove'}</span><span>DESIGN PREVIEW</span></div>
      </>}
    </dialog>
    <footer className="study-footer"><a href="/"><ArrowLeft size={13} />Back to game</a><span>PREVIEW ONLY</span></footer>
  </main>;
}
