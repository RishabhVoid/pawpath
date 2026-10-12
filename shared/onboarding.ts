import { companionKinds, type PlayerProfile, type Species } from './types.js';

export const paceOptions = [
  { value: 'starting', label: 'I’m getting started', detail: 'A little fresh air is a good start.', voice: 'Suggest short, easy outings without pressure.' },
  { value: 'sometimes', label: 'Every now and then', detail: 'I’d like to make it a habit.', voice: 'Encourage a comfortable, regular walking habit without pressure.' },
  { value: 'often', label: 'Most days', detail: 'I already enjoy heading outside.', voice: 'Share enthusiasm for familiar walks and new discoveries without pushing distance.' },
] as const;
export const interestOptions = [
  { value: 'plants', label: 'Leaves & little flowers', detail: 'Slow down and notice the small things.' },
  { value: 'wildlife', label: 'Birds & curious critters', detail: 'There’s always something to spot.' },
  { value: 'water', label: 'Puddles, ponds & the sky', detail: 'Give me clouds and a waterside wander.' },
] as const;
export const toneOptions = [
  { value: 'gentle', label: 'A calm little friend', detail: 'Soft encouragement. No big fuss.', name: 'Gentle', voice: 'Use a calm, reassuring voice with quiet curiosity.' },
  { value: 'playful', label: 'A goofy sidekick', detail: 'A little silliness makes a walk better.', name: 'Playful', voice: 'Use a goofy, playful voice with small jokes and delighted curiosity.' },
  { value: 'bold', label: 'An adventure buddy', detail: 'Let’s see what’s around the next corner.', name: 'Adventurous', voice: 'Use an enthusiastic, adventurous voice while respecting the player’s pace.' },
] as const;
export function matchCompanion(profile: Pick<PlayerProfile, 'pace' | 'interest' | 'tone'>) {
  const interest = interestOptions.find(option => option.value === profile.interest)!;
  const tone = toneOptions.find(option => option.value === profile.tone)!;
  const pace = paceOptions.find(option => option.value === profile.pace)!;
  const matches: Record<PlayerProfile['interest'], Record<PlayerProfile['tone'], Species>> = { plants: { gentle: 'moss', playful: 'pip', bold: 'truffle' }, wildlife: { gentle: profile.pace === 'often' ? 'wisp' : 'cinder', playful: 'bramble', bold: 'reed' }, water: { gentle: 'puddle', playful: 'dew', bold: 'drift' } };
  const species = matches[profile.interest][profile.tone] as keyof typeof companionKinds;
  return { species, reason: `A ${companionKinds[species].toLowerCase()} for your ${tone.name.toLowerCase()} adventures.`, personality: tone.name, voice: `${tone.voice} ${pace.voice} Be curious about ${interest.label.toLowerCase()}, but never invent sightings.` };
}

export function companionStory(profile: Pick<PlayerProfile, 'pace' | 'interest' | 'tone'>) {
  const match = matchCompanion(profile);
  const personalities = {
    gentle: { trait: 'Quietly curious', reflection: 'You chose calm company. Your buddy notices the little things and gives you room to find your own pace.', habit: 'Happy to sit beside you and watch the world for a while.' },
    playful: { trait: 'A little mischief', reflection: 'You chose a goofy sidekick. Your buddy finds a little delight in ordinary things and shares it with you.', habit: 'A puddle, a leaf, a funny shadow—there’s always something to get excited about.' },
    bold: { trait: 'Bright-eyed explorer', reflection: 'You chose an adventure buddy. Yours is curious about the next corner, but always happy to follow your pace.', habit: 'Loves an unfamiliar path and a tiny discovery to bring home.' },
  }[profile.tone];
  const interests = { plants: 'Leaves, flowers, and the small things growing underfoot.', wildlife: 'Birdsong, curious critters, and movement in the trees.', water: 'Clouds overhead, ripples, and the quiet beside water.' }[profile.interest];
  const pace = { starting: 'Short, easy wanders. One little outing at a time.', sometimes: 'A familiar little ritual, whenever you’re ready.', often: 'An everyday companion for familiar paths and new corners.' }[profile.pace];
  return { ...personalities, interests, pace, memory: `The player chose ${match.personality.toLowerCase()} company. ${personalities.reflection} Favourite discoveries: ${interests} Walking preference: ${pace}` };
}
