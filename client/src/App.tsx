import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Camera, Check, Cloud, Copy, Flag, Flower2, Footprints, Heart, Leaf, LoaderCircle, MapPin, MessageCircle, NotebookPen, PawPrint, RefreshCw, Settings, ShoppingBag, Smartphone, Sparkles, Star, Sun, Trees, Users, Wifi, X, Zap } from 'lucide-react';
import { PetArt } from './PetArt.js';
import { PixelCreature } from './PixelCreature.js';
import { previewCreatures } from './pets-preview-data.js';
import QRCode from 'qrcode';
import { AccountScreen } from './AccountScreen.js';
import { browserSupport, enableBrowserAI, type GemmaPhase } from './lib/browser-ai.js';
import { deleteDownloadedModel, hasInstalledModel } from './lib/model-cache.js';
import { hostStatus, startHosting, sleepHost, stopBrowserHosts, type HostStatus } from './lib/browser-host.js';
import { GemmaControls } from './GemmaControls.js';
import { MemoryPhoto } from './MemoryPhoto.js';
import { JourneyMap } from './JourneyMap.js';
import { isHandheld } from './lib/device.js';
import { Onboarding } from './Onboarding.js';
import { Shop } from './Shop.js';
import { companionStory, matchCompanion, paceOptions, interestOptions } from '../../shared/onboarding.js';
import { api, post, ensureAccount, ApiError } from './lib/api.js';
import { brainChat, brainPlace, brainVision, getPairing, savePairing, laptopHealth } from './lib/brain.js';
import { keepWalkAwake, locate, watchWalk } from './lib/walk.js';
import { resizePhoto } from './lib/photo.js';
import { chirp } from './lib/sound.js';
import { nextLevelXp, geoCell } from '../../shared/pet.js';
import type { Pet, Memory, Friend, Walk, Place, Status, Usage, BrainMode, PlayerProfile, Category, JourneyPlan } from '../../shared/types.js';

type Tab = 'companion' | 'journal' | 'friends' | 'shop' | 'settings';
const nav = [{ id: 'companion', label: 'Shelter', icon: PawPrint }, { id: 'journal', label: 'Field notes', icon: NotebookPen }, { id: 'friends', label: 'Friends', icon: Users }, { id: 'shop', label: 'Outfitter', icon: ShoppingBag }] as const;
const categoryIcon = { bird: Sparkles, tree: Trees, flower: Flower2, water: Cloud, sky: Sun, other: Footprints };
const distanceLabel = (meters: number) => (meters / 1000).toFixed(2);
const durationLabel = (seconds: number) => Math.floor(seconds / 60).toString().padStart(2, '0') + ':' + (seconds % 60).toString().padStart(2, '0');

export function App() {
  const [tab, setTab] = useState<Tab>('companion');
  const [welcome, setWelcome] = useState(false), [editingProfile, setEditingProfile] = useState(false);
  const [legacyAccess, setLegacyAccess] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [browserAI, setBrowserAI] = useState<Awaited<ReturnType<typeof browserSupport>>>({ text: 'unavailable', vision: 'unavailable' });
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [wakingGemma, setWakingGemma] = useState(false);
  const [gemmaPhase, setGemmaPhase] = useState<GemmaPhase>('downloading');
  const wakeVersion = useRef(0);
  const wakeInFlight = useRef(false), automaticWake = useRef(false), wakeSuppressed = useRef(false);
  const [host, setHost] = useState<HostStatus>({ online: false, hostingHere: false, model: 'Gemma 4 E2B' });
  const [handoff, setHandoff] = useState<{ url: string; image: string; expiresAt: number; used?: boolean } | null>(null);
  const [handoffJourney, setHandoffJourney] = useState<JourneyPlan | null>(null);
  const [phoneJourney, setPhoneJourney] = useState<JourneyPlan | null>(() => { try { return JSON.parse(localStorage.getItem('pawpath.walk-plan') || 'null'); } catch { return null; } });
  const journeyAttempted = useRef(false), developerAI = useRef(false);
  const [screenAwake, setScreenAwake] = useState(false), [wakeAttempt, setWakeAttempt] = useState(0);
  const handheld = isHandheld();
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [panel, setPanel] = useState<'start' | 'chat' | 'places' | 'profile' | 'collection' | 'handoff' | 'wake' | null>(null);
  const [recap, setRecap] = useState<{ xp: number; distanceM: number; seconds: number; leveled: boolean } | null>(null);
  const [pet, setPet] = useState<Pet | null>(null), [walk, setWalk] = useState<Walk | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]), [friends, setFriends] = useState<Friend[]>([]);
  const [status, setStatus] = useState<Status | null>(null), [usage, setUsage] = useState<Usage | null>(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(''), [thinking, setThinking] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [line, setLine] = useState('');
  const [mode, setMode] = useState<BrainMode>(handheld ? 'host' : 'browser');
  const [online, setOnline] = useState(false), [muted, setMuted] = useState(localStorage.getItem('pawpath.muted') === 'true');
  const [keepPhotos, setKeepPhotos] = useState(localStorage.getItem('pawpath.keep-photos') === 'true');
  const [friendCode, setFriendCode] = useState(''), [addCode, setAddCode] = useState(''), [pairLink, setPairLink] = useState('');
  const [distanceM, setDistanceM] = useState(0), [clock, setClock] = useState(Date.now());
  const [place, setPlace] = useState<Place | null>(null), [placeState, setPlaceState] = useState<'idle' | 'ready' | 'empty' | 'unavailable'>('idle'), [placeStale, setPlaceStale] = useState(false), [placeProvider, setPlaceProvider] = useState<'geoapify' | 'overpass' | null>(null), [chat, setChat] = useState('');
  const cells = useRef(new Set<string>()), fileInput = useRef<HTMLInputElement>(null), booting = useRef(false);
  const nudgeShown = useRef(false);
  const inferenceBusy = useRef(false);
  const speechVersion = useRef(0);
  const placeVersion = useRef(0);
  const currentDistance = useRef(0); currentDistance.current = distanceM;
  const syncing = useRef(false);

  async function loadPet() {
    const data = await api<{ pet: Pet | null; walk: Walk | null }>('/pet');
    setPet(data.pet); setWalk(data.walk);
    if (data.walk) {
      setDistanceM(data.walk.distanceM); cells.current = new Set(data.walk.geoCells);
      try { const saved = JSON.parse(localStorage.getItem('pawpath.walk') || 'null'); if (saved?.id === data.walk._id && data.walk.trackingHere !== false) { setDistanceM(Math.max(data.walk.distanceM, saved.distanceM || 0)); cells.current = new Set([...data.walk.geoCells, ...(saved.cells || [])]); } } catch { /* Corrupt local progress never prevents restoring the server walk. */ }
    }
    return data.pet;
  }
  async function refreshMemories() { const data = await api<{ memories: Memory[] }>('/memory'); setMemories(data.memories); }
  async function refreshFriends() { const data = await api<{ friends: Friend[] }>('/friends'); setFriends(data.friends); }
  async function refreshUsage() { setUsage(await api<Usage>('/usage')); }
  async function boot() {
    if (booting.current) return;
    booting.current = true; setBusy('connecting'); setError('');
    try {
      const continuation = new URLSearchParams(location.hash.slice(1)).get('continue');
      if (continuation) {
        const result = await post<{ token: string; preferences: { mode: BrainMode; muted: boolean; keepPhotos?: boolean; tab: Tab; line: string; setup?: object; welcome: boolean; editing: boolean; pairingLink?: string; journey?: JourneyPlan } }>('/handoff/claim', { code: continuation });
        localStorage.setItem('pawpath.token', result.token); localStorage.removeItem('pawpath.walk'); localStorage.removeItem('pawpath.setup'); localStorage.removeItem('pawpath.pairing'); localStorage.removeItem('pawpath.walk-plan');
        const preferences = result.preferences;
        setKeepPhotos(Boolean(preferences.keepPhotos)); localStorage.setItem('pawpath.keep-photos', String(Boolean(preferences.keepPhotos)));
        if (preferences.setup) localStorage.setItem('pawpath.setup', JSON.stringify(preferences.setup));
        if (preferences.pairingLink) { savePairing(preferences.pairingLink); developerAI.current = true; }
        setMode(developerAI.current ? 'laptop' : handheld ? 'host' : 'browser'); setMuted(preferences.muted); localStorage.setItem('pawpath.muted', String(preferences.muted)); setTab(preferences.journey ? 'companion' : preferences.tab); setLine(preferences.line); setWelcome(preferences.welcome); setEditingProfile(preferences.editing);
        setPhoneJourney(preferences.journey || null); journeyAttempted.current = false;
        if (preferences.journey) localStorage.setItem('pawpath.walk-plan', JSON.stringify(preferences.journey));
        history.replaceState(null, '', location.pathname + location.search);
        setNotice('You’re here. Your buddy and adventures came with you.');
      }
      if (new URLSearchParams(location.hash.slice(1)).has('pair')) { savePairing(location.href); history.replaceState(null, '', location.pathname + location.search); developerAI.current = true; setMode('laptop'); }
      const health = await api<Status>('/health'); setStatus(health); setOnline(health.localBrain);
      const browser = await browserSupport(); setBrowserAI(browser);
      if (!developerAI.current) setMode(browser.text === 'unavailable' ? 'host' : 'browser');
      let account;
      try { account = await ensureAccount(); } catch (e) { if (!(e instanceof ApiError) || e.status !== 401) throw e; localStorage.removeItem('pawpath.token'); account = null; }
      if (!account) { setLegacyAccess(false); setUsername(null); setReady(true); return; }
      setUsername(account.username); setFriendCode(account.friendCode); setProfile(account.profile);
      const connectedHost = await hostStatus(); setHost(connectedHost);
      const existing = await loadPet();
      setLegacyAccess(Boolean(existing && !account.username));
      setReady(true);
      if (existing) {
        const results = await Promise.allSettled([refreshMemories(), refreshFriends(), refreshUsage()]);
        if (results.some(result => result.status === 'rejected')) setNotice('Some saved details could not load. Try opening Field notes or Friends again.');
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'We could not connect. Please try again.'); }
    finally { setBusy(''); booting.current = false; }
  }
  useEffect(() => { void boot(); }, []);
  useEffect(() => { localStorage.setItem('pawpath.mode', mode); }, [mode]);
  useEffect(() => { if (!developerAI.current) setMode(browserAI.text === 'unavailable' ? 'host' : 'browser'); }, [browserAI.text, host.online]);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!walk || walk.trackingHere === false) return;
    const stop = watchWalk((meters, cell) => { cells.current.add(cell); setDistanceM(previous => { const total = previous + meters; localStorage.setItem('pawpath.walk', JSON.stringify({ id: walk._id, distanceM: total, cells: [...cells.current].slice(0, 1000) })); return total; }); }, setNotice);
    return stop;
  }, [walk?._id, walk?.trackingHere]);
  useEffect(() => {
    if (!walk || walk.trackingHere === false) return;
    return keepWalkAwake(setScreenAwake);
  }, [walk?._id, walk?.trackingHere, wakeAttempt]);
  useEffect(() => {
    if (!ready || !pet || (!username && !legacyAccess) || busy || !phoneJourney || journeyAttempted.current || !handheld || welcome || editingProfile) return;
    journeyAttempted.current = true;
    if (walk) { setPhoneJourney(null); localStorage.removeItem('pawpath.walk-plan'); return; }
    setPanel('start');
  }, [ready, pet?._id, username, legacyAccess, busy, phoneJourney, walk?._id, welcome, editingProfile]);
  useEffect(() => {
    if (!pet || !profile || welcome || editingProfile || walk) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => { clearTimeout(timer); if (!document.hidden && !nudgeShown.current) timer = setTimeout(() => { nudgeShown.current = true; setNotice('Time for fresh air? Your pet’s ready when you are.'); }, 60_000); };
    document.addEventListener('visibilitychange', schedule); schedule();
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', schedule); };
  }, [pet?._id, profile, welcome, editingProfile, walk?._id]);
  useEffect(() => { if (!ready) return; const check = async () => { if (document.hidden) return; try { const health = await api<Status>('/health'); setStatus(health); setOnline(getPairing() ? await laptopHealth() : health.localBrain); } catch { setOnline(false); } }; void check(); const timer = setInterval(() => void check(), 60_000); return () => clearInterval(timer); }, [ready]);
  useEffect(() => { if (!pet) return; if (tab === 'journal') void refreshMemories().catch(e => setError(e.message)); if (tab === 'friends') void refreshFriends().catch(e => setError(e.message)); }, [tab, pet?._id]);

  useEffect(() => {
    if (!ready || (!username && !legacyAccess)) return;
    let active = true;
    const check = async () => { try { const [connected, browser] = await Promise.all([hostStatus(), browserSupport()]); if (active) { setHost(connected); setBrowserAI(browser); } } catch { if (active) setHost(previous => ({ ...previous, online: false, hostingHere: false })); } };
    void check(); const timer = setInterval(() => void check(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [ready, username, legacyAccess]);

  useEffect(() => {
    if (!ready || (!username && !legacyAccess) || handheld || developerAI.current || busy || wakingGemma || browserAI.text !== 'downloadable' || host.online || automaticWake.current || wakeSuppressed.current) return;
    let active = true;
    const version = wakeVersion.current;
    void hasInstalledModel().then(installed => {
      if (!active || !installed || wakeSuppressed.current || version !== wakeVersion.current) return;
      automaticWake.current = true;
      void wakeGemma(true);
    }).catch(() => {});
    return () => { active = false; };
  }, [ready, username, legacyAccess, busy, wakingGemma, browserAI.text, host.online]);

  function clearDevice() {
    wakeVersion.current++; wakeInFlight.current = false; automaticWake.current = false; wakeSuppressed.current = false; setWakingGemma(false); sleepHost(); setHost({ online: false, hostingHere: false, model: 'Gemma 4 E2B' });
    speechVersion.current++; placeVersion.current++;
    for (const key of ['pawpath.token', 'pawpath.walk', 'pawpath.setup', 'pawpath.pairing', 'pawpath.walk-plan', 'pawpath.keep-photos']) localStorage.removeItem(key);
    setKeepPhotos(false); setPhoneJourney(null); setHandoffJourney(null); journeyAttempted.current = false; developerAI.current = false;
    setLegacyAccess(false); setUsername(null); setPet(null); setProfile(null); setWalk(null); setDistanceM(0); cells.current = new Set(); setMemories([]); setFriends([]); setLine(''); setRecap(null); setPanel(null); setWelcome(false); setEditingProfile(false); setTab('companion'); setHandoff(null);
  }
  async function connectAccount(token: string) {
    clearDevice(); localStorage.setItem('pawpath.token', token); setReady(false); await boot();
  }
  async function checkpoint() {
    if (!walk || walk.trackingHere === false) return;
    await post('/walk/progress', { walkId: walk._id, distanceM: currentDistance.current, geoCells: [...cells.current].slice(0, 1000) });
  }
  async function makeHandoff(journey?: JourneyPlan) {
    setHandoff(null); setHandoffJourney(journey || null);
    await task('handoff', async () => {
      await checkpoint();
      const pairing = developerAI.current ? getPairing() : null;
      const pairingLink = pairing ? location.origin + '/#pair=' + btoa(JSON.stringify(pairing)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : undefined;
      let setup: object | undefined;
      try { setup = JSON.parse(localStorage.getItem('pawpath.setup') || 'null') || undefined; } catch {}
      const data = await post<{ url: string; expiresAt: number }>('/handoff', { origin: location.origin, preferences: { mode: developerAI.current ? 'laptop' : 'host', muted, keepPhotos, tab: walk || journey ? 'companion' : tab, line, ...(setup ? { setup } : {}), welcome: journey ? false : welcome, editing: journey ? false : editingProfile, ...(pairingLink ? { pairingLink } : {}), ...(journey ? { journey } : {}) } });
      const image = await QRCode.toDataURL(data.url, { width: 280, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#211e2c', light: '#f2dbc0' } });
      setHandoff({ ...data, image });
    });
  }
  useEffect(() => {
    if (!ready || (!username && !legacyAccess)) return;
    let active = true;
    const sync = async () => {
      if (document.hidden || syncing.current || busy || thinking) return;
      syncing.current = true;
      try {
        await checkpoint();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) { syncing.current = false; return; }
      }
      try {
        const data = await api<{ pet: Pet | null; walk: Walk | null; profile: PlayerProfile | null; memories: Memory[] }>('/sync');
        if (!active) return;
        setPet(data.pet); setProfile(data.profile); setMemories(data.memories);
        if (data.walk) {
          if (data.walk.trackingHere === false || !walk) { setDistanceM(data.walk.distanceM); cells.current = new Set(data.walk.geoCells); }
          setWalk(data.walk);
        } else if (walk) { setWalk(null); localStorage.removeItem('pawpath.walk'); }
        await refreshFriends();
      } catch (error) { if (active && error instanceof ApiError && error.status === 401) clearDevice(); }
      finally { syncing.current = false; }
    };
    const timer = setInterval(() => void sync(), 4000);
    const focus = () => void sync(); window.addEventListener('focus', focus);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [ready, username, legacyAccess, walk?._id, walk?.trackingHere, busy, thinking]);

  useEffect(() => {
    if (panel !== 'handoff' || !handoff || handoff.used) return;
    let active = true;
    const check = async () => {
      try { const data = await post<{ used: boolean }>('/handoff/status', { code: new URL(handoff.url).hash.slice('#continue='.length) }); if (active && data.used) { setHandoff(previous => previous?.url === handoff.url ? { ...previous, used: true } : previous); setNotice('Your buddy is ready on your phone.'); } } catch {}
    };
    const timer = setInterval(() => void check(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, [panel, handoff?.url, handoff?.used]);

  async function task(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong. Try again.'); } finally { setBusy(''); }
  }
  async function speak(text: string) {
    if (inferenceBusy.current) return false;
    const version = ++speechVersion.current;
    inferenceBusy.current = true; setThinking(true); setNotice('');
    try {
      const reply = await brainChat(text, mode, status);
      if (version !== speechVersion.current) return false;
      setLine(reply.line);
      chirp(pet?.species || 'pip', reply.line.split(/\s+/).length);
      await refreshUsage().catch(() => {});
      return true;
    } catch (e) { if (version === speechVersion.current) setNotice(e instanceof Error ? e.message : 'Pet chat is unavailable. Your walk still counts.'); return false; }
    finally { inferenceBusy.current = false; setThinking(false); }
  }
  async function createPet(answers: PlayerProfile, petName: string) {
    await task('creating', async () => {
      const data = await api<{ pet: Pet; profile: PlayerProfile }>('/onboarding', { method: editingProfile ? 'PUT' : 'POST', body: JSON.stringify({ profile: answers, name: petName }) });
      setPet(data.pet); setProfile(data.profile); setWelcome(true); localStorage.removeItem('pawpath.setup'); chirp(data.pet.species);
      await refreshUsage().catch(() => {});
    });
  }
  async function startWalk(onThisDevice = false, plan: JourneyPlan = phoneJourney || (place ? { destination: { name: place.name, lat: place.lat, lon: place.lon } } : {})) {
    if (!handheld && !onThisDevice) { placeVersion.current++; setPanel('handoff'); await makeHandoff(plan); return; }
    await task('starting', async () => {
      await locate();
      const data = await post<{ walk: Walk }>('/walk/start', plan);
      placeVersion.current++; setWalk(data.walk); setPanel(null); setTab('companion'); setDistanceM(data.walk.distanceM); cells.current = new Set(data.walk.geoCells);
      setPhoneJourney(null); localStorage.removeItem('pawpath.walk-plan'); localStorage.removeItem('pawpath.walk'); chirp(pet!.species);
      if (canTalk) void speak('We are starting an outdoor walk. Give me one tiny encouragement.');
    });
  }
  async function endWalk() {
    await task('finishing', async () => {
      const data = await post<{ pet: Pet; walk: Walk; reward: { xp: number }; memoryWarning?: string }>('/walk/end', { walkId: walk!._id, distanceM, geoCells: [...cells.current].slice(0, 1000) });
      const leveled = data.pet.level > pet!.level;
      speechVersion.current++; placeVersion.current++; setThinking(false);
      setLine(data.reward.xp > 0 ? 'That was lovely. Another wander soon?' : 'Aw, I was hoping for a little wander. Try again with me?');
      setPet(data.pet); setWalk(null); setPlace(null); setPlaceState('idle'); localStorage.removeItem('pawpath.walk');
      setRecap({ xp: data.reward.xp, distanceM: data.walk.distanceM, seconds: Math.max(0, Math.floor(((data.walk.endedAt || Date.now()) - data.walk.startedAt) / 1000)), leveled });
      setNotice(data.memoryWarning || '');
      if (data.reward.xp > 0) {
        await refreshMemories().catch(() => setNotice('Walk saved. Reopen Field notes to refresh your memories.'));
        void speak('We finished a ' + distanceLabel(data.walk.distanceM) + ' km walk.' + (leveled ? ' I grew to level ' + data.pet.level + '!' : '') + ' React briefly in your pet voice.');
      }
    });
  }
  async function photo(file: File) {
    await task('photo', async () => {
      const image = await resizePhoto(file), result = await brainVision(image, mode, keepPhotos);
      if (!result.is_outdoor || result.is_screen) { setNotice('Try an outdoor photo of a tree, flower, bird, or sky.'); return; }
      setNotice('Discovery saved: ' + result.label); await refreshMemories();
      void speak('We just discovered: ' + result.label + ' (' + result.category + '). React with curiosity, using a relevant past memory only if one exists.');
    });
  }
  async function chooseNearby(data: { places: Place[]; suggestion: Place | null; seenCategories: Category[] }, version: number) {
    if (!data.suggestion || inferenceBusy.current || !(mode === 'browser' ? browserAI.text === 'available' : mode === 'host' ? host.online : online)) return;
    inferenceBusy.current = true; setThinking(true);
    try {
      const candidates = [data.suggestion, ...data.places.filter(candidate => candidate.id !== data.suggestion!.id)];
      const reply = await brainPlace(candidates, data.seenCategories, mode, status);
      if (version !== placeVersion.current) return;
      setPlace(reply.place); setLine(reply.line); chirp(pet!.species, reply.line.split(/\s+/).length);
    } catch (e) { if (version === placeVersion.current) setNotice(e instanceof Error ? e.message : 'Your nearby suggestion is ready. Gemma could not choose a spot.'); }
    finally { inferenceBusy.current = false; setThinking(false); }
  }
  async function findPlace() {
    await task('places', async () => {
      const version = ++placeVersion.current;
      setNotice('');
      const unavailable = () => { setPlace(null); setPlaceState('unavailable'); setPlaceStale(false); setPlaceProvider(null); };
      let position: GeolocationPosition;
      try { position = await locate(); } catch { unavailable(); return; }
      const [lat, lon] = geoCell(position.coords.latitude, position.coords.longitude).split(',');
      let data: { places: Place[]; suggestion: Place | null; seenCategories: Category[]; availability: 'ready' | 'empty' | 'unavailable'; stale: boolean; provider: 'geoapify' | 'overpass' | null };
      try { data = await api('/places?lat=' + lat + '&lon=' + lon); }
      catch (e) { if (e instanceof ApiError && e.status < 500 && e.status !== 429) throw e; unavailable(); return; }
      setPlace(data.suggestion); setPlaceState(data.availability); setPlaceStale(data.stale); setPlaceProvider(data.provider);
      setNotice('');
      void chooseNearby(data, version);
      await refreshUsage().catch(() => {});
    });
  }
  const elapsed = walk ? Math.max(0, Math.floor((clock - walk.startedAt) / 1000)) : 0;
  const displaySpecies = pet?.species || 'pip';
  const petExpression = !walk && pet && pet.mood < 40 ? 'sad' : line ? 'happy' : 'idle';
  const busyIcon = <LoaderCircle size={19} className="spin"/>;
  const pendingRecall = memories.filter(memory => memory.embeddingStatus !== 'ready').length;
  const canTalk = mode === 'browser' ? browserAI.text === 'available' : mode === 'host' ? host.online : online;
  const canPhoto = mode === 'browser' ? browserAI.vision === 'available' : mode === 'host' ? host.online : online;
  const xpFloor = pet ? (pet.level - 1) ** 2 * 100 : 0;
  const xpGoal = pet ? nextLevelXp(pet.level) : 100;
  const xpProgress = pet ? Math.min(100, Math.max(0, (pet.xp - xpFloor) / (xpGoal - xpFloor) * 100)) : 0;
  const accountReady = Boolean(username || legacyAccess);
  const onboarding = !accountReady || !pet || (!profile && !walk) || editingProfile || welcome;
  async function wakeGemma(cachedOnly = false) {
    if (wakeInFlight.current || busy) return;
    wakeInFlight.current = true; automaticWake.current = true; wakeSuppressed.current = false;
    const version = ++wakeVersion.current;
    setWakingGemma(true); setGemmaPhase('loading'); setDownloadProgress(0); setError('');
    try {
      const saved = cachedOnly || await hasInstalledModel().catch(() => false);
      if (version !== wakeVersion.current) return;
      setGemmaPhase(saved ? 'loading' : 'downloading');
      await enableBrowserAI(progress => { if (version === wakeVersion.current) setDownloadProgress(progress); }, saved, phase => { if (version === wakeVersion.current) setGemmaPhase(phase); });
      if (version !== wakeVersion.current) return;
      setGemmaPhase('connecting');
      await startHosting();
      if (version !== wakeVersion.current) return;
      setHost(await hostStatus()); setMode('browser'); setNotice('Gemma is awake. You can play here or continue on your phone.');
    } catch (error) { if (version === wakeVersion.current) setError(error instanceof Error ? error.message : 'Gemma could not wake up.'); }
    finally { if (version === wakeVersion.current) { wakeInFlight.current = false; setWakingGemma(false); setBrowserAI(await browserSupport()); } }
  }
  async function removeGemma() {
    if (busy) return false;
    setBusy('deleting-model'); setError(''); setNotice('');
    wakeVersion.current++; wakeInFlight.current = false; wakeSuppressed.current = true; setWakingGemma(false); stopBrowserHosts(); setDownloadProgress(0);
    setHost(previous => previous.hostingHere ? { ...previous, online: false, hostingHere: false } : previous);
    try {
      await deleteDownloadedModel();
      setNotice('Gemma’s download was deleted from this browser. Your pet and adventures stay saved. Wake Gemma to download it again.');
      return true;
    } catch (error) { setError(error instanceof Error ? error.message : 'The model could not be deleted. Please try again.'); return false; }
    finally { setBrowserAI(await browserSupport()); setBusy(''); }
  }
  const gemmaControls = <GemmaControls browser={browserAI} host={host} progress={downloadProgress} phase={gemmaPhase} loading={wakingGemma} disabled={Boolean(busy)} wake={() => { developerAI.current = false; void wakeGemma(); }} sleep={() => { wakeVersion.current++; wakeInFlight.current = false; wakeSuppressed.current = true; setWakingGemma(false); sleepHost(); void hostStatus().then(setHost).catch(() => {}); void browserSupport().then(setBrowserAI); setNotice('Gemma is sleeping. Your adventures stay saved.'); }} remove={removeGemma}/>;
  const closePanel = () => setPanel(null);
  const switchTab = (next: Tab) => { setTab(next); setPanel(null); setError(''); setNotice(''); window.scrollTo({ top: 0 }); };

  return <div className={'game-shell theme-' + (onboarding && tab !== 'settings' ? 'setup' : tab)}>
    <div className="game-rain" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ left: `${(index * 37) % 101}%`, animationDelay: `${-(index % 9) * .19}s`, animationDuration: `${1.6 + index % 4 * .15}s` }}/>)}</div>
    <header className="game-header">
      {tab === 'settings' ? <button className="round-button" onClick={() => switchTab('companion')} aria-label="Back to pet"><ArrowLeft size={22}/></button> : <span className="wordmark"><span className="brand-star" aria-hidden="true">✦</span>pawpath</span>}
      <div className="header-actions">{pet && !onboarding && tab !== 'settings' && <button className="xp-pill" onClick={() => setPanel('profile')} aria-label={'View ' + pet.name + ', level ' + pet.level}><Star size={17} fill="currentColor"/>{pet.xp} XP</button>}{accountReady && !handheld && tab !== 'settings' && <button className="round-button" onClick={() => { setPanel('handoff'); void makeHandoff(); }} aria-label="Continue on your phone"><Smartphone size={22}/></button>}{accountReady && pet && tab !== 'settings' && <button className="round-button" onClick={() => switchTab('settings')} aria-label="Settings"><Settings size={22}/></button>}</div>
    </header>
    <main className="game-main">
      {error && <div className="alert error" role="alert"><span>{error}</span><button className="round-button" onClick={() => ready ? setError('') : void boot()} aria-label={ready ? 'Dismiss error' : 'Retry connection'}>{ready ? <X size={18}/> : <RefreshCw size={18}/>}</button></div>}
      {notice && <div className="alert notice" role="status"><span>{notice}</span><button className="round-button" onClick={() => setNotice('')} aria-label="Dismiss notice"><X size={18}/></button></div>}
      {!ready ? <section className="loading-screen"><PetArt species="pip"/><h1>{error ? 'Can’t connect.' : 'Waking up…'}</h1><p>{error ? 'Start the app server, then try again.' : 'Getting your pet ready.'}</p>{!error && <LoaderCircle size={28} className="spin"/>}{error && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void boot()}>Try again <RefreshCw size={20}/></button>}</section> : <>
        {!accountReady && <AccountScreen existingPet={pet || undefined} onConnected={connectAccount} onCancel={pet ? () => { setLegacyAccess(true); switchTab('companion'); } : undefined}/>}
        {accountReady && onboarding && tab !== 'settings' && <Onboarding pet={pet} profile={profile} welcome={welcome} busy={Boolean(busy)} onSave={createPet} onCancel={() => { localStorage.removeItem('pawpath.setup'); setEditingProfile(false); switchTab('companion'); }} onPlay={() => { setWelcome(false); setEditingProfile(false); switchTab('companion'); }}/>}
        {!onboarding && tab === 'companion' && <section className="pet-screen">
          <div className="game-intro">
          {walk ? <><div className="heading-row"><h1>Out for a wander.</h1><span className="live-tag"><span/>WALKING</span></div><div className="walk-metrics" aria-label="Current walk"><div><strong>{distanceLabel(distanceM)}</strong><span>kilometers</span></div><div><strong>{durationLabel(elapsed)}</strong><span>time outside</span></div></div></> : <><h1>A little outside?</h1><p className="screen-description">{pet!.name} {petExpression === 'sad' ? 'is still hoping for a walk.' : pet!.hunger < 30 ? 'could use a snack. Walk together?' : 'is ready when you are.'}</p></>}
          </div>
          <div className={'character-stage home-stage species-' + displaySpecies + (walk ? ' walking-stage' : '')}>
            <div className="home-habitat" aria-hidden="true"><span className="habitat-orbit"/><span className="habitat-ledge"/><span className="habitat-plant"/><span className="habitat-plant second"/></div>
            <button className="pet-profile-hit" onClick={() => setPanel('profile')} aria-label={'Meet ' + pet!.name + ': view pet stats'}><PetArt species={displaySpecies} tone={pet?.companion?.tone} expression={petExpression} walking={Boolean(walk)} equipped={pet?.equippedItems}/></button><div className="trail-sign"><strong>{pet!.name}</strong><small>Level {pet!.level} · {pet?.companion ? matchCompanion(pet.companion).personality : 'Trail buddy'}</small></div>
            {(thinking || line) && <div className="pet-speech" role="status">{thinking ? <><LoaderCircle size={16} className="spin"/>Thinking…</> : line}</div>}
          </div>
          <div className="game-actions">
          <div className="level-progress"><div className="xp-track" role="progressbar" aria-label="Progress to next level" aria-valuenow={Math.round(xpProgress)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: xpProgress + '%' }}/></div><span>{Math.max(0, xpGoal - pet!.xp)} XP to level {pet!.level + 1}</span></div>
          {walk?.trackingHere === false ? <><p className="quiet-note">This walk is continuing on your other device.</p><button className="primary-button full" disabled={Boolean(busy)} onClick={() => { if (!handheld) { setPanel('handoff'); void makeHandoff(); return; } void task('resume', async () => { await locate(); const data = await post<{ walk: Walk }>('/walk/resume'); setWalk(data.walk); setDistanceM(data.walk.distanceM); cells.current = new Set(data.walk.geoCells); }); }}>{handheld ? 'Continue walking here' : 'Connect another phone'} <Footprints size={20}/></button></> : walk ? <><div className={'walk-screen-notice ' + (screenAwake ? 'awake' : '')} role="status"><Smartphone size={20}/><div><strong>{screenAwake ? 'Screen stays on during your walk' : 'Keep your screen on'}</strong><p>{screenAwake ? 'Leave Pawpath open. Locking your phone or switching apps pauses distance tracking.' : 'Automatic screen wake is unavailable. Keep Pawpath open and check your phone’s auto-lock setting.'}</p>{!screenAwake && navigator.wakeLock && <button className="text-button" onClick={() => setWakeAttempt(attempt => attempt + 1)}>Try keeping screen awake <RefreshCw size={14}/></button>}</div></div><button className="primary-button full camera-action" onClick={() => canPhoto ? fileInput.current?.click() : setPanel('wake')} disabled={Boolean(busy) || thinking}>{busy === 'photo' ? busyIcon : <Camera size={22}/>} {canPhoto ? 'Capture a discovery' : 'Enable photo discoveries'}</button>{walk.destination && <JourneyMap destination={walk.destination}/>}<button className="secondary-button full" disabled={Boolean(busy)} onClick={() => void endWalk()}>{busy === 'finishing' ? busyIcon : <Flag size={20}/>}Finish walk</button></> : <><button className="primary-button full" disabled={Boolean(busy)} onClick={() => handheld ? setPanel('start') : void startWalk()}><Footprints size={22}/>Start a walk <ArrowRight size={21}/></button><div className="home-shortcuts"><button className="text-button" onClick={() => setPanel('chat')}><MessageCircle size={19}/>Say hello</button><button className="text-button" onClick={() => setPanel('places')}><MapPin size={19}/>Nearby spots</button></div></>}
          <button className="connection-hint" onClick={() => setPanel('wake')}><Sparkles size={16}/>{wakingGemma ? gemmaPhase === 'downloading' ? `Downloading Gemma… ${Math.round(downloadProgress * 100)}%` : gemmaPhase === 'warming' ? 'Warming up Gemma…' : gemmaPhase === 'connecting' ? 'Connecting Gemma…' : 'Loading saved Gemma…' : canTalk ? mode === 'host' ? 'Gemma on your computer' : mode === 'browser' ? 'Gemma is awake' : 'Development model connected' : 'Wake Gemma for chats & discoveries'} <ArrowRight size={16}/></button>
          {status?.storage === 'development' && <button className="connection-hint" onClick={() => switchTab('settings')}>Progress is temporary. Fix saving <ArrowRight size={16}/></button>}
          </div>
        </section>}
        {!onboarding && tab === 'journal' && <section className="journal-screen"><div className="heading-row"><h1>Field notes</h1><span className="count-sticker">{memories.length}<small>moments</small></span></div><p className="screen-description">Things you and {pet!.name} found together.</p><button className="secondary-button full" onClick={() => canPhoto ? fileInput.current?.click() : setPanel('wake')} disabled={Boolean(busy) || thinking}>{busy === 'photo' ? busyIcon : <Camera size={21}/>} {canPhoto ? 'Add a discovery' : 'Enable photo discoveries'}</button><div className="setting-row photo-preference"><div><h2>Keep photos</h2><p>{keepPhotos ? "Small photos stay private in your field notes. Up to 50." : "Only the discovery note is saved."}</p></div><button className={"toggle " + (keepPhotos ? "on" : "")} role="switch" aria-label="Keep photos" aria-checked={keepPhotos} disabled={Boolean(busy)} onClick={() => { const value = !keepPhotos; setKeepPhotos(value); localStorage.setItem("pawpath.keep-photos", String(value)); }}><span/></button></div>{!memories.length ? <Empty icon={Flower2} title="Nothing found. Yet." text="Head outside and snap a tree, flower, or bird."/> : <div className="memory-list">{memories.map(memory => { const Icon = categoryIcon[memory.category] || Leaf; return <article className={'memory-card category-' + memory.category + (memory.hasPhoto ? ' has-photo' : '')} key={memory._id}>{memory.hasPhoto && <MemoryPhoto id={memory._id} label={memory.text}/>}<span className="memory-icon"><Icon size={26}/></span><div className="memory-details"><span className="small-label">{memory.category === 'other' ? 'WALK' : memory.category}</span><h2>{memory.text}</h2><time dateTime={new Date(memory.createdAt).toISOString()}>{new Date(memory.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</time></div></article>; })}</div>}<p className="quiet-note">Photos are saved only when Keep photos is on. Clear memories removes saved photos too.</p></section>}
        {!onboarding && tab === 'friends' && <section className="friends-screen"><span className="small-label">GOOD COMPANY</span><h1>Your walking club</h1><p className="screen-description">Bring a friend. Meet their sidekick.</p><section className="friend-code-card"><span className="small-label">YOUR INVITE CODE</span><div><strong>{friendCode}</strong><button className="round-button" aria-label="Copy friend code" onClick={() => void task('copy', async () => { await navigator.clipboard.writeText(friendCode); setNotice('Code copied. Send it to a friend.'); })}><Copy size={20}/></button></div></section><form className="add-friend" onSubmit={e => { e.preventDefault(); void task('friend', async () => { await post('/friends', { code: addCode }); setAddCode(''); await refreshFriends(); setNotice('Friend added. You can both see each other’s pets.'); }); }}><label htmlFor="friend-code">Have a friend’s code?</label><div><input id="friend-code" autoComplete="off" placeholder="Enter their code" value={addCode} onChange={e => setAddCode(e.target.value.toUpperCase())} maxLength={10}/><button className="primary-button" disabled={Boolean(busy) || !/^[A-F0-9]{10}$/.test(addCode)}>{busy === 'friend' ? busyIcon : 'Add'}</button></div></form>{friends.length ? <div className="friend-grid">{friends.map(friend => <article className={'friend-card species-' + friend.species} key={friend.id}><PetArt species={friend.species} equipped={friend.equippedItems} small/><h2>{friend.name}</h2><span className="small-label">LEVEL {friend.level}</span>{friend.traits.length > 0 && <div className="trait-list">{friend.traits.map(trait => <span key={trait}>{trait}</span>)}</div>}</article>)}</div> : <Empty icon={Users} title="Your pack starts here." text="Share your code or add a friend above."/>}<p className="quiet-note">Friends see your pet. Your location stays private.</p></section>}
        {!onboarding && tab === 'shop' && pet && <Shop pet={pet} onChange={setPet}/>}
        {accountReady && tab === 'settings' && <section className="settings-screen"><h1>Settings</h1><section className="settings-section"><h2>Your account</h2><p className="setting-description">{username ? <>Signed in as <strong>@{username}</strong>. Your buddy follows you when you sign in elsewhere.</> : <>Your buddy is saved on this browser. Choose a username and password to sign in anywhere.</>}</p>{!username && <button className="primary-button full" onClick={() => void task('save-account', async () => { await checkpoint(); setLegacyAccess(false); setTab('companion'); })}>Choose my username <ArrowRight size={18}/></button>}{!handheld && <button className="secondary-button full" onClick={() => { setPanel('handoff'); void makeHandoff(); }}><Smartphone size={19}/>Continue on my phone</button>}<button className="text-button centered" disabled={Boolean(busy)} onClick={() => void task('logout', async () => { await post('/account/logout'); clearDevice(); })}>Sign out on this device</button></section>{profile && <details className="settings-section advanced"><summary>Your companion preferences</summary><h2>Your adventure, {profile.nickname}</h2><dl className="player-details"><div><dt>Walking pace</dt><dd>{paceOptions.find(option => option.value === profile.pace)!.label}</dd></div><div><dt>Favourite discoveries</dt><dd>{interestOptions.find(option => option.value === profile.interest)!.label}</dd></div><div><dt>Companion personality</dt><dd>{matchCompanion(profile).personality}</dd></div></dl><p className="setting-description">{matchCompanion(profile).reason} These setup answers are private.</p><button className="text-button" disabled={Boolean(walk)} onClick={() => { localStorage.removeItem('pawpath.setup'); setEditingProfile(true); switchTab('companion'); }}>Update your answers <ArrowRight size={17}/></button>{walk && <p className="quiet-note">Finish your walk before updating your companion.</p>}</details>}<section className="settings-section"><div className="setting-row"><div><h2>Pet sounds</h2><p>Little blips, big personality.</p></div><button className={'toggle ' + (!muted ? 'on' : '')} role="switch" aria-label="Pet sounds" aria-checked={!muted} onClick={() => { const value = !muted; setMuted(value); localStorage.setItem('pawpath.muted', String(value)); if (!value) chirp(displaySpecies); }}><span/></button></div></section><section className="settings-section"><div className="section-heading"><h2>Your buddy’s voice</h2><span className={'connection-status ' + (canTalk ? 'connected' : '')}>{canTalk ? 'Ready' : 'Not connected'}</span></div><p className="setting-description">For little chats and photo discoveries. Walks still count when your buddy’s voice is offline.</p>{gemmaControls}
          <details className="advanced"><summary>Developer Ollama connection</summary><div className="pairing-row"><label htmlFor="pair-link">Optional pairing link from the laptop helper</label><input id="pair-link" type="url" placeholder="Paste the full pairing link" value={pairLink} onChange={e => setPairLink(e.target.value)}/><button className="text-button" onClick={() => { developerAI.current = true; setMode('laptop'); }}>Use development Ollama</button><button className="secondary-button full" disabled={!pairLink || Boolean(busy)} onClick={() => void task('pairing', async () => { savePairing(pairLink); setPairLink(''); developerAI.current = true; setMode('laptop'); setOnline(await laptopHealth()); setNotice('Laptop paired.'); })}>Connect laptop</button>{getPairing() && <button className="text-button" onClick={() => { localStorage.removeItem('pawpath.pairing'); developerAI.current = false; setMode(browserAI.text === 'unavailable' ? 'host' : 'browser'); setOnline(Boolean(status?.localBrain)); setNotice('Laptop unpaired.'); }}>Disconnect paired laptop</button>}</div></details></section><details className="settings-section advanced"><summary>Saved data & troubleshooting</summary><p className="setting-description">{status?.storage === 'mongodb' ? 'Your adventures are saved to your private account.' : 'Saving isn’t connected yet. Progress is temporary until it’s fixed.'} Photos are kept only when you choose Keep photos in Field notes. Only a rough area is saved for walks.</p><p className="setting-description">Your buddy remembers saved discoveries when they’re relevant to your chat.</p>{pendingRecall > 0 && <button className="secondary-button full" disabled={Boolean(busy)} onClick={() => void task('recall', async () => { await post('/memory/retry'); await refreshMemories(); setNotice('Memory recall updated.'); })}>{busy === 'recall' ? busyIcon : <RefreshCw size={18}/>}Retry {pendingRecall} pending memories</button>}<button className="secondary-button full" disabled={Boolean(busy)} onClick={() => void task('health', async () => { const health = await api<Status>('/health'); setStatus(health); setOnline(getPairing() ? await laptopHealth() : health.localBrain); setNotice('Connection checked.'); })}>Check connection <RefreshCw size={18}/></button>{pet && <button className="danger-button full" disabled={Boolean(busy)} onClick={() => { if (confirm('Delete all saved memories and their photos? Your pet and level will stay.')) void task('delete-memory', async () => { await api('/memory', { method: 'DELETE' }); setMemories([]); setLine(''); setNotice('Memories cleared.'); }); }}>Clear memories</button>}<button className="danger-button full" disabled={Boolean(busy)} onClick={() => { if (confirm('Permanently delete your pet, walks, memories, and friendships?')) void task('delete-account', async () => { await api('/account', { method: 'DELETE' }); for (const key of ['pawpath.token', 'pawpath.walk', 'pawpath.pairing', 'pawpath.walk-plan', 'pawpath.keep-photos']) localStorage.removeItem(key); setKeepPhotos(false); setPhoneJourney(null); setLegacyAccess(false); setUsername(null); setPet(null); setWalk(null); setMemories([]); setFriends([]); setLine(''); setProfile(null); setEditingProfile(false); localStorage.removeItem('pawpath.setup'); setWelcome(false); setRecap(null); setReady(false); switchTab('companion'); void boot(); }); }}>Delete account</button></details>{welcome && <button className="primary-button full" onClick={() => switchTab('companion')}>Back to setup <ArrowRight size={20}/></button>}</section>}
      </>}
      <input ref={fileInput} className="visually-hidden" type="file" accept="image/*" capture="environment" aria-label="Take a discovery photo" onChange={e => { const file = e.target.files?.[0]; if (file) void photo(file); e.target.value = ''; }}/>
    </main>
    {pet && !onboarding && ready && <nav className="game-nav" aria-label="Main navigation">{nav.map(item => <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => switchTab(item.id)} aria-current={tab === item.id ? 'page' : undefined}><item.icon size={22}/><span>{item.label}</span>{item.id === 'companion' && walk && <i className="walk-dot"/>}</button>)}</nav>}
    {panel === 'wake' && <GameDialog title="A voice for your buddy." onClose={closePanel} feedback={error || notice}>{gemmaControls}</GameDialog>}
    {panel === 'handoff' && <GameDialog title={handoffJourney ? 'Your walk starts on your phone.' : 'Take your buddy with you.'} onClose={closePanel} feedback={error || notice}><p>{handoffJourney ? 'Scan once to bring your buddy and destination along. Allow location on your phone to start tracking.' : 'Scan with your phone to continue with your buddy, saved adventures, and current walk.'}</p>{handoffJourney?.destination && <p className="handoff-destination"><MapPin size={18}/>{handoffJourney.destination.name}</p>}{handoff?.used ? <div className="handoff-success"><Check size={36}/><h3>Phone connected.</h3><p>{walk ? 'Your walk is ready on your phone.' : handoffJourney ? 'Allow location on your phone to begin your walk.' : 'Your buddy and adventures are on your phone.'}</p></div> : handoff ? <><img className="handoff-qr" src={handoff.image} alt="Scan to continue your Pawpath account on your phone"/><p className="quiet-note">{clock < handoff.expiresAt ? `This private code expires in ${Math.max(0, Math.ceil((handoff.expiresAt - clock) / 1000))} seconds. Use it once.` : 'This code has expired. Make a fresh one below.'}</p><button className="secondary-button full" disabled={Boolean(busy)} onClick={() => void task('copy-handoff', async () => { await navigator.clipboard.writeText(handoff.url); setNotice('Continuation link copied.'); })}><Copy size={18}/>Copy continuation link</button></> : <p role="status">{busy ? 'Packing your adventures…' : 'Make a code to continue on your phone.'}</p>}<button className="text-button centered" disabled={Boolean(busy)} onClick={() => void makeHandoff(handoffJourney || undefined)}><RefreshCw size={17}/>Make a fresh code</button><p className="quiet-note">{host.online ? 'Gemma stays on your computer. Keep its Pawpath tab open and the computer awake.' : 'Wake Gemma on your laptop to bring chats and photo discoveries along too.'}</p><p className="quiet-note">Keep this one-use code private.{location.protocol !== 'https:' && <> Phone GPS needs HTTPS. Local Wi-Fi links can connect your account, but cannot track a walk.</>}</p></GameDialog>}
    {panel === 'start' && <GameDialog title="Let’s head outside." locked={Boolean(busy)} onClose={closePanel} feedback={error || notice}><div className="dialog-art"><Footprints size={48}/></div><p>{phoneJourney?.destination || place ? <>Heading to <strong>{(phoneJourney?.destination || place)!.name}</strong> with {pet!.name}.</> : <>Walk to feed {pet!.name}. Every 10 recorded meters earns 1 XP.</>}</p><div className="permission-note"><MapPin size={21}/><span>Tap below, then allow location in your browser. If no prompt appears, check this site’s location permission. We’ll try to keep your screen on until you finish. Leave Pawpath open; locking your phone or switching apps pauses distance tracking.</span></div><button className="primary-button full" disabled={Boolean(busy)} onClick={() => void startWalk(true)}>{busy === 'starting' ? <>{busyIcon}Waiting for location…</> : <>{phoneJourney ? 'Allow location & start' : 'Start exploring'} <ArrowRight size={21}/></>}</button><button className="text-button centered" disabled={Boolean(busy)} onClick={() => setPanel('places')}>Find a nearby spot first</button></GameDialog>}
    {panel === 'chat' && <GameDialog title={'Hello, ' + pet!.name + '.'} onClose={closePanel} feedback={error || notice}><PetArt species={pet!.species} tone={pet?.companion?.tone} expression={petExpression} equipped={pet?.equippedItems} small/>{canTalk ? <><div className="chat-response" role="status">{thinking ? <><LoaderCircle size={19} className="spin"/>Thinking…</> : line || 'Say hello, or ask about a past discovery.'}</div><form className="chat-form" onSubmit={e => { e.preventDefault(); const text = chat.trim(); if (text) void speak(text).then(sent => { if (sent) setChat(current => current.trim() === text ? '' : current); }); }}><label className="visually-hidden" htmlFor="pet-chat">Message to {pet!.name}</label><input id="pet-chat" autoFocus placeholder="Say something…" value={chat} onChange={e => setChat(e.target.value)} maxLength={500}/><button className="round-button" aria-label="Send message" disabled={thinking || Boolean(busy) || !chat.trim()}>{thinking ? busyIcon : <ArrowRight size={21}/>}</button></form></> : <><p>Wake Gemma for little chats. Your walks still count while it’s asleep.</p><button className="primary-button full" onClick={() => setPanel('wake')}>Wake Gemma <ArrowRight size={21}/></button></>}</GameDialog>}
    {panel === 'places' && <GameDialog title="Where shall we go?" locked={Boolean(busy)} onClose={closePanel} feedback={error || notice}>
      <div className="dialog-art"><Trees size={50}/></div>
      {place ? <><h3 className="place-name">{place.name}</h3><p>{(place.distanceM / 1000).toFixed(1)} km away{placeStale && <> · Saved spot</>}</p><button className="primary-button full" disabled={Boolean(busy)} onClick={() => walk ? closePanel() : void startWalk()}>{walk ? 'Back to my walk' : 'Walk here'} <Footprints size={20}/></button><a className="text-button centered" href={'https://www.google.com/maps/dir/?api=1&destination=' + place.lat + ',' + place.lon + '&travelmode=walking'} target="_blank" rel="noreferrer">Preview walking directions <ArrowUpRight size={16}/></a></> : <>
        <p>{placeState === 'unavailable' ? 'Let’s find a spot on Maps instead.' : placeState === 'empty' ? 'No mapped spots within 2 km. Try Maps or your own route.' : 'Find a real park, garden, or trail within 2 km.'}</p>
        {placeState === 'idle' ? <button className="primary-button full" disabled={Boolean(busy)} onClick={() => void findPlace()}>{busy === 'places' ? busyIcon : <MapPin size={21}/>}Find a spot</button> : <a className="primary-button full" href="https://www.google.com/maps/search/?api=1&query=parks+near+me" target="_blank" rel="noreferrer">Find parks on Maps <ArrowUpRight size={21}/></a>}
        <button className="text-button centered" disabled={Boolean(busy)} onClick={() => { if (walk) closePanel(); else { setPlace(null); void startWalk(false, {}); } }}>{walk ? 'Back to my walk' : 'I’ll take my own route'}</button>
        {placeState !== 'idle' && <button className="text-button centered" disabled={Boolean(busy)} onClick={() => void findPlace()}>{busy === 'places' ? busyIcon : <RefreshCw size={16}/>}Check here again</button>}
      </>}
      {place && <a className="text-button centered" href="https://www.google.com/maps/search/?api=1&query=parks+near+me" target="_blank" rel="noreferrer">More parks on Maps <ArrowUpRight size={16}/></a>}
      {placeProvider === 'geoapify' && <a className="map-credit" href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Powered by Geoapify</a>}
      <a className="map-credit" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
    </GameDialog>}
    {panel === 'profile' && pet && <GameDialog title={pet.name} onClose={closePanel} feedback={error || notice}><PetArt species={pet.species} tone={pet.companion?.tone} expression={petExpression} equipped={pet?.equippedItems} small/><div className="profile-level"><Star size={19} fill="currentColor"/>Level {pet.level} · {pet.xp} XP</div><div className="pet-stats">{[{ label: 'Fullness', value: pet.hunger, icon: Leaf }, { label: 'Mood', value: pet.mood, icon: Heart }, { label: 'Energy', value: pet.energy, icon: Zap }].map(stat => <div key={stat.label}><stat.icon size={20}/><span>{stat.label}</span><meter min={0} max={100} value={stat.value} aria-label={stat.label}/><strong>{Math.round(stat.value)}</strong></div>)}</div><p>{pet.companion ? companionStory(pet.companion).reflection : "A little company for your adventures."}</p>{pet.companion && <dl className="bond-details"><div><dt>Little joys</dt><dd>{companionStory(pet.companion).interests}</dd></div><div><dt>Your rhythm</dt><dd>{companionStory(pet.companion).pace}</dd></div></dl>}<p className="quiet-note">Walks feed your buddy. Rest restores energy.</p>{pet.traits.length > 0 && <div className="trait-list">{pet.traits.map(trait => <span key={trait}>{trait}</span>)}</div>}<button className="text-button centered" onClick={() => setPanel('collection')}>Meet all 10 wanderers <ArrowRight size={17}/></button></GameDialog>}
    {panel === 'collection' && <GameDialog className="companion-guide" title="The little field guide." onClose={closePanel}><p>Your answers find your buddy. Ten different kinds of company.</p><div className="companion-grid">{previewCreatures.map(creature => <article key={creature.id}><PixelCreature pet={creature}/><strong>{creature.name}</strong><span>{creature.kind}</span></article>)}</div></GameDialog>}
    {recap && <GameDialog className="walk-recap" title={recap.xp === 0 ? 'Maybe a little wander?' : recap.leveled ? 'A little bigger!' : 'A good little wander.'} onClose={() => setRecap(null)} feedback={error || notice}>
      <div className="reward-art"><PetArt species={displaySpecies} tone={pet?.companion?.tone} expression={recap.xp === 0 ? 'sad' : 'happy'} equipped={pet?.equippedItems}/><span className={'reward-sticker' + (recap.xp === 0 ? ' no-reward' : '')}>{recap.xp === 0 ? 'No XP this time' : '+' + recap.xp + ' XP'}</span></div>
      <div className="recap-metrics"><div><strong>{recap.distanceM < 1000 ? Math.floor(recap.distanceM) + ' m' : distanceLabel(recap.distanceM) + ' km'}</strong><span>recorded distance</span></div><div><strong>{recap.seconds < 60 ? recap.seconds + ' sec' : Math.floor(recap.seconds / 60) + ' min'}</strong><span>session time</span></div></div>
      <p>{recap.xp === 0 ? pet!.name + ' was hoping for a walk. A few steps together?' : recap.leveled ? pet!.name + ' reached level ' + pet!.level + '.' : 'Fresh air. A happier pet. Good work.'}</p>
      {recap.xp === 0 && <p className="quiet-note">Walked already? Keep the app open so GPS can record your steps.</p>}
      <button className="primary-button full" onClick={() => { setRecap(null); switchTab('companion'); if (recap.xp === 0) setPanel('start'); }}>{recap.xp === 0 ? <>Try a short walk <Footprints size={21}/></> : <>Nice! <Check size={21}/></>}</button>
      <button className="text-button centered" onClick={() => { setRecap(null); switchTab(recap.xp === 0 ? 'companion' : 'journal'); }}>{recap.xp === 0 ? 'I’ll try later' : <>See field notes <ArrowRight size={17}/></>}</button>
    </GameDialog>}
  </div>;
}

function Empty({ icon: Icon, title, text }: { icon: typeof Leaf; title: string; text: string }) {
  return <div className="empty-state"><Icon size={48}/><h2>{title}</h2><p>{text}</p></div>;
}

function GameDialog({ title, children, onClose, feedback, locked = false, className = '' }: { title: string; children: ReactNode; onClose: () => void; feedback?: string; locked?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className={'game-dialog' + (className ? ' ' + className : '')} aria-labelledby={id} onCancel={e => { if (locked) e.preventDefault(); else onClose(); }} onClick={e => { if (!locked && e.target === e.currentTarget) { const bounds = e.currentTarget.getBoundingClientRect(); if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) onClose(); } }}><div className="dialog-content"><div className="dialog-heading"><h2 id={id}>{title}</h2><button className="round-button" disabled={locked} onClick={onClose} aria-label="Close"><X size={22}/></button></div>{feedback && <div className="dialog-feedback" role="status">{feedback}</div>}{children}</div></dialog>;
}
