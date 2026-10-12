import { useEffect, useRef, useState } from 'react';
import { Check, Coins, LoaderCircle, Shirt, ShoppingBag, X } from 'lucide-react';
import type { Pet } from '../../shared/types.js';
import { shopState, type ShopItem, type ShopState } from '../../shared/shop.js';
import { api, post } from './lib/api.js';
import { PetArt } from './PetArt.js';
import { ItemArt } from './ItemArt.js';

export function Shop({ pet, onChange }: { pet: Pet; onChange: (pet: Pet) => void }) {
  const previewRef = useRef<HTMLElement>(null);
  const [data, setData] = useState<ShopState>(() => shopState(pet));
  const [section, setSection] = useState<'shop' | 'wardrobe'>('shop');
  const [selected, setSelected] = useState<ShopItem | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    api<ShopState>('/shop').then(value => { if (active) setData(value); }).catch(error => { if (active) setError(error.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [pet._id, pet.wardrobeVersion]);
  const owned = selected ? data.ownedItems.includes(selected.id) : false;
  const wearing = selected ? data.equippedItems[selected.slot] === selected.id : false;
  const affordable = selected ? data.points >= selected.price : false;
  const preview = selected ? { ...data.equippedItems, [selected.slot]: selected.id } : data.equippedItems;
  const retired = Object.entries(data.equippedItems).filter(([, id]) => !data.catalog.some(item => item.id === id));
  const visible = data.catalog.filter(item => (section === 'shop' || data.ownedItems.includes(item.id)));

  async function save() {
    if (!selected || busy || loading) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const updated = await post<ShopState>(owned ? '/shop/equip' : '/shop/purchase', owned ? { slot: selected.slot, itemId: wearing ? null : selected.id } : { itemId: selected.id });
      setData(updated); onChange(updated.pet);
      setMessage(wearing ? selected.name + ' tucked away.' : selected.name + ' looks good on ' + pet.name + '.');
      if (wearing) setSelected(null);
    } catch (error) { setError(error instanceof Error ? error.message : 'Your outfit could not save. Try again.'); }
    finally { setBusy(false); }
  }

  async function removeOlderItems() {
    if (busy || loading) return;
    setBusy(true); setError(''); setMessage('');
    try {
      let updated = data;
      for (const [slot] of retired) updated = await post<ShopState>('/shop/equip', { slot, itemId: null });
      setData(updated); onChange(updated.pet); setSelected(null); setMessage('Older accessories tucked away.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Your outfit could not save. Try again.'); }
    finally { setBusy(false); }
  }

  return <section className="shop-screen" aria-labelledby="shop-heading">
    <div className="shop-heading"><div><span className="small-label">FIVE LITTLE FINDS</span><h1 id="shop-heading">The outfitter.</h1></div><div className="points-wallet" aria-label={data.points + ' shop points'}><Coins size={23}/><strong>{data.points}</strong><span>points</span></div></div>
    {error && <div className="alert error" role="alert"><span>{error}</span><button className="round-button" onClick={() => setError('')} aria-label="Dismiss shop error"><X size={18}/></button></div>}
    <div className="shop-layout">
      <aside ref={previewRef} className="outfit-preview">
        <div className="preview-heading"><span className="small-label">{selected && !wearing ? 'TRYING ON' : 'YOUR BUDDY'}</span>{selected && <button className="round-button" onClick={() => { setSelected(null); setMessage(''); }} disabled={busy} aria-label="Reset try-on"><X size={17}/></button>}</div>
        <div className="shop-pet-stage"><PetArt species={pet.species} tone={pet.companion?.tone} equipped={preview} expression="happy"/></div>
        <div className="outfit-caption"><h2>{selected?.name || pet.name}</h2><p>{selected?.description || 'Pick something. See how it fits.'}</p></div>
        {selected ? <>
          <button className="primary-button full" onClick={() => void save()} disabled={loading || busy || (!owned && !affordable)}>{busy ? <><LoaderCircle size={19} className="spin"/>Saving outfit…</> : owned ? <><Shirt size={19}/>{wearing ? 'Take off' : 'Wear this'}</> : selected.price === 0 ? <><ShoppingBag size={19}/>Get it free & wear</> : <><Coins size={19}/>Buy & wear · {selected.price}</>}</button>
          {!owned && !affordable && <p className="quiet-note">{selected.price - data.points} more points to make it yours.</p>}
          {owned && <p className="quiet-note"><Check size={13}/> Yours to keep.</p>}
        </> : <p className="quiet-note">Try on anything. Save the outfit you love.</p>}
        {retired.length > 0 && <button className="text-button centered" disabled={busy || loading} onClick={() => void removeOlderItems()}>Take off older items</button>}
        {message && <p className="outfit-message" role="status">{message}</p>}
      </aside>
      <div className="shop-shelves">
        <div className="shop-switch" aria-label="Shop or owned wardrobe">{([{ id: 'shop', label: 'The shop', icon: ShoppingBag }, { id: 'wardrobe', label: 'My wardrobe', icon: Shirt }] as const).map(tab => <button key={tab.id} aria-pressed={section === tab.id} className={section === tab.id ? 'selected' : ''} onClick={() => { setSection(tab.id); setSelected(null); setMessage(''); }}><tab.icon size={18}/>{tab.label}</button>)}</div>
        {loading && <p className="quiet-note" role="status"><LoaderCircle size={16} className="spin"/> Opening the outfitter…</p>}
        <div className="shop-grid">{visible.map(item => <button key={item.id} className={'shop-item' + (selected?.id === item.id ? ' selected' : '')} onClick={() => { setSelected(item); setError(''); setMessage(''); if (window.matchMedia('(max-width: 700px)').matches) previewRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }} aria-pressed={selected?.id === item.id} aria-label={'Try on ' + item.name}>
          <span className="item-swatch"><ItemArt itemId={item.id}/>{data.equippedItems[item.slot] === item.id && <span className="item-tag"><Check size={12}/>Wearing</span>}</span>
          <strong>{item.name}</strong><span className="item-price">{data.ownedItems.includes(item.id) ? <><Check size={13}/>Owned</> : item.price === 0 ? 'Free starter' : <><Coins size={14}/>{item.price} points</>}</span>
        </button>)}</div>
        {!visible.length && <div className="empty-wardrobe"><Shirt size={34}/><h2>A little room to grow.</h2><p>{section === 'wardrobe' ? 'Your outfits will live here. Start with the free bandana or bell.' : 'Try another shelf.'}</p>{section === 'wardrobe' && <button className="secondary-button" onClick={() => { setSection('shop'); }}>Browse the shop</button>}</div>}
        <p className="shop-rewards-note"><Coins size={15}/>Points rewards arrive with events. Your two starter items are free.</p>
      </div>
    </div>
  </section>;
}
