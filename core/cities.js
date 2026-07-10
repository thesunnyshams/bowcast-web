/**
 * Cities for programmatic rainbow-forecast pages. Categories select the
 * climate prose in build-pages.js. Coordinates are city centers; the
 * forecast ring covers ~12 km around them.
 */
export const CITIES = [
  // Trade-wind belt: the world's most reliable rainbow weather
  { slug: 'honolulu', name: 'Honolulu', region: 'Hawaii', country: 'United States', lat: 21.31, lon: -157.86, cat: 'tradewind' },
  { slug: 'hilo', name: 'Hilo', region: 'Hawaii', country: 'United States', lat: 19.72, lon: -155.09, cat: 'tradewind' },
  { slug: 'lihue', name: 'Lihue', region: 'Hawaii', country: 'United States', lat: 21.98, lon: -159.37, cat: 'tradewind' },
  { slug: 'kahului', name: 'Kahului', region: 'Maui, Hawaii', country: 'United States', lat: 20.89, lon: -156.47, cat: 'tradewind' },
  { slug: 'san-juan', name: 'San Juan', region: 'Puerto Rico', country: 'United States', lat: 18.47, lon: -66.11, cat: 'tradewind' },
  { slug: 'papeete', name: 'Papeete', region: 'Tahiti', country: 'French Polynesia', lat: -17.55, lon: -149.56, cat: 'tradewind' },
  { slug: 'nadi', name: 'Nadi', region: '', country: 'Fiji', lat: -17.8, lon: 177.42, cat: 'tradewind' },

  // North Atlantic shower country
  { slug: 'dublin', name: 'Dublin', region: '', country: 'Ireland', lat: 53.35, lon: -6.26, cat: 'atlantic' },
  { slug: 'galway', name: 'Galway', region: '', country: 'Ireland', lat: 53.27, lon: -9.05, cat: 'atlantic' },
  { slug: 'cork', name: 'Cork', region: '', country: 'Ireland', lat: 51.9, lon: -8.47, cat: 'atlantic' },
  { slug: 'belfast', name: 'Belfast', region: 'Northern Ireland', country: 'United Kingdom', lat: 54.6, lon: -5.93, cat: 'atlantic' },
  { slug: 'glasgow', name: 'Glasgow', region: 'Scotland', country: 'United Kingdom', lat: 55.86, lon: -4.25, cat: 'atlantic' },
  { slug: 'edinburgh', name: 'Edinburgh', region: 'Scotland', country: 'United Kingdom', lat: 55.95, lon: -3.19, cat: 'atlantic' },
  { slug: 'fort-william', name: 'Fort William', region: 'Scotland', country: 'United Kingdom', lat: 56.82, lon: -5.11, cat: 'atlantic' },
  { slug: 'cardiff', name: 'Cardiff', region: 'Wales', country: 'United Kingdom', lat: 51.48, lon: -3.18, cat: 'atlantic' },
  { slug: 'manchester', name: 'Manchester', region: 'England', country: 'United Kingdom', lat: 53.48, lon: -2.24, cat: 'atlantic' },
  { slug: 'london', name: 'London', region: 'England', country: 'United Kingdom', lat: 51.51, lon: -0.13, cat: 'atlantic' },
  { slug: 'bergen', name: 'Bergen', region: '', country: 'Norway', lat: 60.39, lon: 5.32, cat: 'atlantic' },
  { slug: 'stavanger', name: 'Stavanger', region: '', country: 'Norway', lat: 58.97, lon: 5.73, cat: 'atlantic' },
  { slug: 'torshavn', name: 'Tórshavn', region: '', country: 'Faroe Islands', lat: 62.01, lon: -6.77, cat: 'atlantic' },

  // Pacific Northwest storm-light
  { slug: 'victoria-bc', name: 'Victoria', region: 'British Columbia', country: 'Canada', lat: 48.43, lon: -123.37, cat: 'pnw' },
  { slug: 'vancouver', name: 'Vancouver', region: 'British Columbia', country: 'Canada', lat: 49.28, lon: -123.12, cat: 'pnw' },
  { slug: 'tofino', name: 'Tofino', region: 'British Columbia', country: 'Canada', lat: 49.15, lon: -125.91, cat: 'pnw' },
  { slug: 'seattle', name: 'Seattle', region: 'Washington', country: 'United States', lat: 47.61, lon: -122.33, cat: 'pnw' },
  { slug: 'portland', name: 'Portland', region: 'Oregon', country: 'United States', lat: 45.52, lon: -122.68, cat: 'pnw' },

  // Mid-ocean islands
  { slug: 'ponta-delgada', name: 'Ponta Delgada', region: 'Azores', country: 'Portugal', lat: 37.74, lon: -25.67, cat: 'island' },
  { slug: 'funchal', name: 'Funchal', region: 'Madeira', country: 'Portugal', lat: 32.65, lon: -16.91, cat: 'island' },
  { slug: 'las-palmas', name: 'Las Palmas', region: 'Canary Islands', country: 'Spain', lat: 28.12, lon: -15.43, cat: 'island' },
  { slug: 'reykjavik', name: 'Reykjavík', region: '', country: 'Iceland', lat: 64.15, lon: -21.94, cat: 'island' },

  // New Zealand and southern light
  { slug: 'auckland', name: 'Auckland', region: '', country: 'New Zealand', lat: -36.85, lon: 174.76, cat: 'nz' },
  { slug: 'wellington', name: 'Wellington', region: '', country: 'New Zealand', lat: -41.29, lon: 174.78, cat: 'nz' },
  { slug: 'christchurch', name: 'Christchurch', region: '', country: 'New Zealand', lat: -43.53, lon: 172.64, cat: 'nz' },
  { slug: 'queenstown', name: 'Queenstown', region: '', country: 'New Zealand', lat: -45.03, lon: 168.66, cat: 'nz' },

  // Waterfall rainbows
  { slug: 'victoria-falls', name: 'Victoria Falls', region: 'Livingstone', country: 'Zambia / Zimbabwe', lat: -17.92, lon: 25.86, cat: 'waterfall' },
  { slug: 'iguazu-falls', name: 'Iguazú Falls', region: 'Misiones', country: 'Argentina / Brazil', lat: -25.69, lon: -54.44, cat: 'waterfall' },
  { slug: 'niagara-falls', name: 'Niagara Falls', region: 'Ontario', country: 'Canada / United States', lat: 43.09, lon: -79.08, cat: 'waterfall' },

  // Tropical shower climates
  { slug: 'singapore', name: 'Singapore', region: '', country: 'Singapore', lat: 1.35, lon: 103.82, cat: 'tropical' },
  { slug: 'kuala-lumpur', name: 'Kuala Lumpur', region: '', country: 'Malaysia', lat: 3.14, lon: 101.69, cat: 'tropical' },
  { slug: 'bangkok', name: 'Bangkok', region: '', country: 'Thailand', lat: 13.76, lon: 100.5, cat: 'tropical' },
  { slug: 'manila', name: 'Manila', region: '', country: 'Philippines', lat: 14.6, lon: 120.98, cat: 'tropical' },
  { slug: 'mumbai', name: 'Mumbai', region: '', country: 'India', lat: 19.08, lon: 72.88, cat: 'tropical' },
  { slug: 'hong-kong', name: 'Hong Kong', region: '', country: 'China', lat: 22.32, lon: 114.17, cat: 'tropical' },
  { slug: 'taipei', name: 'Taipei', region: '', country: 'Taiwan', lat: 25.03, lon: 121.57, cat: 'tropical' },
  { slug: 'cairns', name: 'Cairns', region: 'Queensland', country: 'Australia', lat: -16.92, lon: 145.77, cat: 'tropical' },
  { slug: 'brisbane', name: 'Brisbane', region: 'Queensland', country: 'Australia', lat: -27.47, lon: 153.03, cat: 'tropical' },
  { slug: 'miami', name: 'Miami', region: 'Florida', country: 'United States', lat: 25.76, lon: -80.19, cat: 'tropical' },
  { slug: 'new-orleans', name: 'New Orleans', region: 'Louisiana', country: 'United States', lat: 29.95, lon: -90.07, cat: 'tropical' },
  { slug: 'rio-de-janeiro', name: 'Rio de Janeiro', region: '', country: 'Brazil', lat: -22.91, lon: -43.17, cat: 'tropical' },
  { slug: 'bogota', name: 'Bogotá', region: '', country: 'Colombia', lat: 4.71, lon: -74.07, cat: 'tropical' },
  { slug: 'san-jose-cr', name: 'San José', region: '', country: 'Costa Rica', lat: 9.93, lon: -84.08, cat: 'tropical' },
  { slug: 'panama-city', name: 'Panama City', region: '', country: 'Panama', lat: 8.98, lon: -79.52, cat: 'tropical' },
  { slug: 'nairobi', name: 'Nairobi', region: '', country: 'Kenya', lat: -1.29, lon: 36.82, cat: 'tropical' },

  // Temperate cities with honest shower seasons
  { slug: 'tokyo', name: 'Tokyo', region: '', country: 'Japan', lat: 35.68, lon: 139.69, cat: 'temperate' },
  { slug: 'sydney', name: 'Sydney', region: 'New South Wales', country: 'Australia', lat: -33.87, lon: 151.21, cat: 'temperate' },
  { slug: 'cape-town', name: 'Cape Town', region: '', country: 'South Africa', lat: -33.92, lon: 18.42, cat: 'temperate' },
  { slug: 'zurich', name: 'Zurich', region: '', country: 'Switzerland', lat: 47.37, lon: 8.54, cat: 'temperate' },
  { slug: 'munich', name: 'Munich', region: 'Bavaria', country: 'Germany', lat: 48.14, lon: 11.58, cat: 'temperate' },
  { slug: 'salzburg', name: 'Salzburg', region: '', country: 'Austria', lat: 47.81, lon: 13.05, cat: 'temperate' },
  { slug: 'amsterdam', name: 'Amsterdam', region: '', country: 'Netherlands', lat: 52.37, lon: 4.9, cat: 'temperate' },
  { slug: 'paris', name: 'Paris', region: '', country: 'France', lat: 48.86, lon: 2.35, cat: 'temperate' },
  { slug: 'new-york', name: 'New York', region: 'New York', country: 'United States', lat: 40.71, lon: -74.01, cat: 'temperate' },
  { slug: 'chicago', name: 'Chicago', region: 'Illinois', country: 'United States', lat: 41.88, lon: -87.63, cat: 'temperate' },
  { slug: 'denver', name: 'Denver', region: 'Colorado', country: 'United States', lat: 39.74, lon: -104.99, cat: 'temperate' },
  { slug: 'san-francisco', name: 'San Francisco', region: 'California', country: 'United States', lat: 37.77, lon: -122.42, cat: 'temperate' },
  { slug: 'toronto', name: 'Toronto', region: 'Ontario', country: 'Canada', lat: 43.65, lon: -79.38, cat: 'temperate' },
  { slug: 'montreal', name: 'Montréal', region: 'Quebec', country: 'Canada', lat: 45.5, lon: -73.57, cat: 'temperate' },
];
