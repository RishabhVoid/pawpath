import { useEffect, useState } from 'react';
import { Check, Download, LoaderCircle, Moon, Trash2 } from 'lucide-react';
import type { browserSupport, GemmaPhase } from './lib/browser-ai.js';
import type { HostStatus } from './lib/browser-host.js';
import { hasDownloadedModel, hasInstalledModel } from './lib/model-cache.js';

type Props = { browser: Awaited<ReturnType<typeof browserSupport>>; host: HostStatus; progress: number; phase: GemmaPhase; loading: boolean; disabled: boolean; wake: () => void; sleep: () => void; remove: () => Promise<boolean> };
export function GemmaControls({ browser, host, progress, phase, loading, disabled, wake, sleep, remove }: Props) {
  loading = loading || browser.text === 'downloading';
  const awake = browser.text === 'available';
  const [downloaded, setDownloaded] = useState(false), [removing, setRemoving] = useState(false);
  const [installed, setInstalled] = useState(false), [checking, setChecking] = useState(true);
  const loadingLabel = phase === 'warming' ? 'Warming up Gemma…' : phase === 'connecting' ? 'Connecting Gemma…' : phase === 'loading' ? 'Loading saved Gemma…' : `Downloading Gemma… ${Math.round(progress * 100)}%`;
  useEffect(() => {
    let active = true;
    void Promise.all([hasDownloadedModel(), hasInstalledModel()]).then(([found, complete]) => { if (active) { setDownloaded(found); setInstalled(complete); } }).catch(() => {}).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [awake, loading, removing]);
  async function removeModel() {
    setRemoving(true);
    try { if (await remove()) { setDownloaded(false); setInstalled(false); } }
    finally { setRemoving(false); }
  }
  disabled = disabled || removing;
  return <div className="gemma-controls">
    {browser.text === 'unavailable' ? <><p className="setting-description">{host.online ? 'Your computer is connected. It handles chats and photos while you walk.' : 'Wake Gemma in Pawpath on a computer using Chrome or Edge with WebGPU, then scan the code when you start a walk.'}</p><p className="quiet-note">Your phone handles the walk. No model download needed here.</p>{host.online && <p className="quiet-note">Leave Pawpath open on your computer and keep it awake.</p>}</> : <>
        <p className="setting-description">{awake ? host.hostingHere ? 'Gemma is awake here. This tab can answer for your phone too.' : 'Gemma is awake here. Connect this tab to answer for your phone.' : installed ? 'Gemma is saved in this browser and wakes automatically when you return.' : 'Gemma runs on your device. The first download is about 3.4 GB; Wi-Fi recommended.'}</p>
        <p className="quiet-note">Download once per browser. Later visits wake Gemma automatically. Deleting it or clearing browser storage means downloading again; your browser may also clear unused downloads.</p>
        {!awake || !host.hostingHere ? <button className="primary-button full gemma-wake" disabled={disabled || loading || checking} onClick={wake}><span className="gemma-button-label">{loading || checking ? <LoaderCircle size={20} className="spin"/> : <Download size={20}/>}<span>{loading ? loadingLabel : checking ? 'Checking saved model…' : awake ? 'Reconnect Gemma' : installed ? 'Wake Gemma' : downloaded ? 'Resume download' : 'Download Gemma'}</span></span>{loading && phase === 'downloading' && <span className="gemma-download-fill" style={{ width: Math.round(progress * 100) + '%' }}/>}</button> : <><p className="model-ready"><Check size={18}/><span>Ready for chats and photo discoveries.</span></p><p className="quiet-note">Start a walk to get your phone code. Leave this tab open and your computer awake.</p></>}
        {(awake || loading) && <button className="text-button centered" disabled={disabled} onClick={sleep}><Moon size={17}/><span>{loading ? phase === 'downloading' ? 'Cancel download' : 'Cancel wake-up' : 'Let Gemma sleep'}</span></button>}
        {awake && <p className="quiet-note">Sleeping frees memory. Gemma stays asleep for this visit and wakes automatically next time.</p>}
    </>}
    {(downloaded || awake || loading || removing) && <div className="model-storage"><button className="danger-button full" disabled={disabled} onClick={() => void removeModel()}>{removing ? <LoaderCircle size={17} className="spin"/> : <Trash2 size={17}/>}<span>{removing ? 'Deleting model…' : 'Delete downloaded model'}</span></button><p className="quiet-note">Removes Gemma from this browser and stops it in open Pawpath tabs. Your pet and adventures stay saved. Choose Download Gemma to install it again.</p></div>}
  </div>;
}
