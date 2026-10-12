import { useEffect, useRef, useState } from 'react';

export function MemoryPhoto({ id, label }: { id: string; label: string }) {
  const target = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(''), [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '', started = false;
    async function load() {
      if (started) return;
      started = true;
      try {
        const token = localStorage.getItem('pawpath.token');
        const response = await fetch('/api/memory/' + encodeURIComponent(id) + '/photo', { headers: token ? { Authorization: 'Bearer ' + token } : {}, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
        if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/jpeg')) throw new Error('Photo unavailable');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
      } catch { if (!controller.signal.aborted) setFailed(true); }
    }
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load(); } });
    if (observer && target.current) observer.observe(target.current); else void load();
    return () => { controller.abort(); observer?.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id]);
  return <div ref={target} className="memory-photo">{url ? <img src={url} alt={label}/> : <span>{failed ? 'Photo unavailable' : 'Loading photo…'}</span>}</div>;
}
