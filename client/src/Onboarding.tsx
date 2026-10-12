import { useEffect, useId, useState } from 'react';
import { ArrowLeft, ArrowRight, Camera, Check, Footprints, Heart, LoaderCircle } from 'lucide-react';
import { companionStory, matchCompanion, paceOptions, interestOptions, toneOptions } from '../../shared/onboarding.js';
import { companionKinds, resolveSpecies, type Pet, type PlayerProfile } from '../../shared/types.js';
import { PetArt } from './PetArt.js';

type Draft = Partial<PlayerProfile> & { petName?: string; step?: number };
function readDraft(): Draft {
  try {
    const value = JSON.parse(localStorage.getItem('pawpath.setup') || '{}');
    return {
      step: Number.isInteger(value.step) && value.step >= 0 && value.step <= 4 ? value.step : undefined,
      nickname: typeof value.nickname === 'string' ? value.nickname.slice(0, 24) : undefined,
      petName: typeof value.petName === 'string' ? value.petName.slice(0, 24) : undefined,
      pace: paceOptions.find(option => option.value === value.pace)?.value,
      interest: interestOptions.find(option => option.value === value.interest)?.value,
      tone: toneOptions.find(option => option.value === value.tone)?.value,
    };
  } catch { return {}; }
}

export function Onboarding({ pet, profile, welcome, busy, onSave, onPlay, onCancel }: { pet: Pet | null; profile: PlayerProfile | null; welcome: boolean; busy: boolean; onSave: (profile: PlayerProfile, name: string) => Promise<void>; onPlay: () => void; onCancel: () => void }) {
  const [step, setStep] = useState(() => { const saved = readDraft(); return saved.step ?? (profile || !saved.nickname?.trim() ? 0 : !saved.pace ? 1 : !saved.interest ? 2 : !saved.tone ? 3 : 4); });
  const [draft, setDraft] = useState<Draft>(() => { const saved = readDraft(); return profile ? { ...profile, ...Object.fromEntries(Object.entries(saved).filter(([, value]) => value !== undefined)), petName: saved.petName ?? pet?.name } : { ...saved, petName: saved.petName ?? pet?.name }; });
  const headingId = useId();
  const [advanceKey, setAdvanceKey] = useState(0), [autoAdvance, setAutoAdvance] = useState(false);
  useEffect(() => {
    if (!autoAdvance || busy || welcome || step < 1 || step > 3) return;
    const timer = setTimeout(() => { setAutoAdvance(false); setStep(previous => previous + 1); }, 2000);
    return () => clearTimeout(timer);
  }, [autoAdvance, advanceKey, step, busy, welcome]);
  const moveTo = (next: number) => { setAutoAdvance(false); setStep(next); };
  const story = completeProfileStory(draft);
  const complete = Boolean(draft.nickname?.trim() && draft.pace && draft.interest && draft.tone);
  const match = complete ? matchCompanion(draft as PlayerProfile) : null;
  const species = welcome ? pet!.species : step === 4 ? match?.species : undefined;
  const tone = welcome ? pet?.companion?.tone : draft.tone;
  const petName = draft.petName ?? pet?.name ?? '';
  useEffect(() => { if (!welcome) localStorage.setItem('pawpath.setup', JSON.stringify({ ...draft, step })); }, [draft, step, welcome]);
  useEffect(() => { document.getElementById(headingId)?.focus(); }, [step, welcome, headingId]);
  const update = (value: Draft) => setDraft(previous => ({ ...previous, ...value }));
  const options = step === 1 ? paceOptions : step === 2 ? interestOptions : toneOptions;
  const field = step === 1 ? 'pace' : step === 2 ? 'interest' : 'tone';
  const allowed = step === 0 ? Boolean(draft.nickname?.trim()) : step < 4 ? Boolean(draft[field]) : complete;
  const titles = ['Hello, wanderer.', 'How often do you head outside?', 'What catches your eye?', 'Your kind of company?', 'Meet your trail buddy.'];
  const descriptions = ['Let’s find your little trail buddy.', 'Every pace belongs here.', 'This helps us find your companion.', 'Choose the personality you’d enjoy.', match?.reason || 'Your answers shape your companion.'];

  return <section className={'setup-flow ' + (step < 4 && !welcome ? 'question-flow' : 'match-flow')} aria-labelledby={headingId}>
    <div className="game-intro">
      <div className="step-heading">{step > 0 && !welcome ? <button className="round-button" disabled={busy} onClick={() => moveTo(step - 1)} aria-label="Previous question"><ArrowLeft size={20}/></button> : profile && !welcome ? <button className="round-button" onClick={onCancel} aria-label="Cancel setup and return to pet"><ArrowLeft size={20}/></button> : <span className="small-label">{welcome ? 'ALL PACKED' : 'YOUR TRAIL STARTS HERE'}</span>}<div className="step-count">{profile && step > 0 && !welcome && <button className="text-button" disabled={busy} onClick={onCancel}>Cancel</button>}<span className="small-label">{welcome ? 'READY' : `${step + 1} OF 5`}</span></div></div>
      {!welcome && <div className="setup-progress" aria-label={`Question ${step + 1} of 5`}>{[0, 1, 2, 3, 4].map(index => <span key={index} className={index <= step ? 'done' : ''}/>)}</div>}<h1 id={headingId} tabIndex={-1}>{welcome ? 'You found each other.' : titles[step]}</h1>
      <p className="screen-description">{welcome ? `${profile!.nickname} + ${pet!.name}. Ready for the first wander?` : descriptions[step]}</p>
    </div>
    {species ? <div className={'character-stage species-' + species}><PetArt species={species} tone={tone} equipped={pet?.equippedItems}/><span className="character-name">{welcome ? pet!.name : petName.trim() || companionKinds[resolveSpecies(species)]}</span><span className="stage-spark spark-one">✦</span><span className="stage-spark spark-two">✳</span></div> : <div className="setup-illustration" aria-hidden="true"><TrailKit/></div>}
    <div className="game-actions">
      {welcome ? <><div className="quick-guide"><div><span><Footprints size={20}/></span><p><strong>Walk together</strong>Distance feeds your pet and earns XP.</p></div><div><span><Camera size={20}/></span><p><strong>Find something cool</strong>Snap nature. Your pet remembers it.</p></div></div><button className="primary-button full" onClick={onPlay}>Let’s play <ArrowRight size={21}/></button></> : step === 4 ? <>
        <div className="match-details"><span>{story!.trait}</span><p>{story!.reflection}</p><dl className="bond-details"><div><dt>Little joys</dt><dd>{story!.interests}</dd></div><div><dt>Your rhythm</dt><dd>{story!.pace}</dd></div></dl><p>{pet ? 'Your progress comes along.' : 'Level 1. A whole world ahead.'}</p></div>
        <form className="name-form" onSubmit={e => { e.preventDefault(); if (complete && petName.trim()) void onSave(draft as PlayerProfile, petName.trim()); }}><label htmlFor="pet-name">What should we call your buddy?</label><input id="pet-name" autoComplete="off" placeholder="Mochi, maybe?" value={petName} maxLength={24} onChange={e => update({ petName: e.target.value })} required/><button className="primary-button full" disabled={busy || !petName.trim()}>{busy ? <><LoaderCircle size={19} className="spin"/>Meeting your pet…</> : <>Meet {petName.trim() || 'my pet'} <Heart size={21}/></>}</button></form><p className="quiet-note">Your setup answers are private. Friends only see your pet card.</p>
      </> : <form onSubmit={e => { e.preventDefault(); if (allowed) moveTo(step + 1); }}>
        {step === 0 ? <div className="name-form"><label htmlFor="player-name">What should we call you?</label><input id="player-name" autoComplete="nickname" placeholder="Your nickname" value={draft.nickname || ''} maxLength={24} onChange={e => update({ nickname: e.target.value })} required/><p className="setup-note">A nickname is plenty. No email needed.</p></div> : <fieldset className="question-options"><legend className="visually-hidden">{descriptions[step]}</legend>{options.map(option => <label key={option.value} className={'answer-option ' + (draft[field] === option.value ? 'selected' : '')}><input type="radio" name={field} value={option.value} checked={draft[field] === option.value} onClick={() => { if (draft[field] === option.value) { setAdvanceKey(key => key + 1); setAutoAdvance(true); } }} onChange={() => { update({ [field]: option.value }); setAdvanceKey(key => key + 1); setAutoAdvance(true); }}/><span><strong>{option.label}</strong><small>{option.detail}</small></span><span className="answer-check">{draft[field] === option.value && <Check size={18}/>}</span></label>)}</fieldset>}
        <button className={"primary-button full question-next" + (autoAdvance ? " auto-next" : "")} disabled={!allowed}> {autoAdvance && <span key={advanceKey} className="auto-next-fill" aria-hidden="true"/>}<span>{autoAdvance ? "Continuing in a moment…" : step === 3 ? 'Find my friend' : 'Continue'}</span> <ArrowRight size={21}/></button>
        
      </form>}
    </div>
  </section>;
}

function completeProfileStory(draft: Draft) { return draft.pace && draft.interest && draft.tone ? companionStory(draft as PlayerProfile) : null; }

function TrailKit() {
  return <svg viewBox="0 0 64 64" className="trail-kit" shapeRendering="crispEdges" aria-hidden="true"><path fill="#17131f" d="M13 56h38v3H13z"/><path fill="#c4b5cd" d="M18 17h6v-5h16v5h6v34H18z"/><path fill="#776282" d="M24 17V8h16v9h-4v-5h-8v5zM14 23h4v25h-4zM46 23h4v25h-4z"/><path fill="#e2a583" d="M18 17h28v14H18zM22 39h20v12H22z"/><path fill="#f2dbc0" d="M30 26h4v10h-4zM24 40h16v3H24z"/><path fill="#f2dbc0" d="M8 12h3V9h3v3h3v3h-3v3h-3v-3H8zM51 36h2v-2h2v2h2v2h-2v2h-2v-2h-2z"/></svg>;
}
