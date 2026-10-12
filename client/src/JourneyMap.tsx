import { ArrowUpRight, MapPin } from 'lucide-react';
import type { Destination } from '../../shared/types.js';

export function walkingDirections(destination: Destination) {
  return 'https://www.google.com/maps/dir/?' + new URLSearchParams({ api: '1', destination: destination.lat + ',' + destination.lon, travelmode: 'walking' });
}
export function destinationMap(destination: Destination) {
  const { lat, lon } = destination;
  const bbox = [Math.max(-180, lon - .008), Math.max(-90, lat - .005), Math.min(180, lon + .008), Math.min(90, lat + .005)].join(',');
  return 'https://www.openstreetmap.org/export/embed.html?' + new URLSearchParams({ bbox, layer: 'mapnik', marker: lat + ',' + lon });
}
export function JourneyMap({ destination }: { destination: Destination }) {
  return <section className="journey-map" aria-label="Your walk destination">
    <div className="journey-destination"><MapPin size={18}/><strong>{destination.name}</strong></div>
    <iframe title={'Map of ' + destination.name} src={destinationMap(destination)} referrerPolicy="no-referrer"/>
    <a className="text-button" href={walkingDirections(destination)} target="_blank" rel="noreferrer">Open walking directions <ArrowUpRight size={16}/></a>
    <p className="quiet-note">Return to Pawpath after checking directions. Distance pauses in other apps.</p>
  </section>;
}
