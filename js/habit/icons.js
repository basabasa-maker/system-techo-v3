// Stable IDs keep saved items independent of the selected visual artwork.
export const IMAGE_HABIT_ICONS = Object.freeze([
  ['bicycle','自転車'], ['swim','水泳'], ['clean','掃除'], ['laundry','洗濯'],
  ['toothbrush','歯みがき'], ['bath','入浴'], ['bed','休息'], ['water','水分補給'],
  ['milk','牛乳'], ['tea','お茶'], ['egg','卵'], ['broccoli','野菜'],
  ['grapes','果物'], ['dog','ペット'], ['plant','植物'], ['computer','パソコン'],
  ['writing','書く'], ['receipt','家計'], ['movie','映画'], ['puzzle','パズル'],
].map(([key,label],index) => Object.freeze({id:'habit-image:'+key,label,index})));
const byId = new Map(IMAGE_HABIT_ICONS.map(item => [item.id,item]));
// A single picker follows everyday use. These groupings are ordering rules only;
// no category labels, separators, or new/legacy distinction appear in the UI.
const ICON_ORDER = [
  // Morning, personal routines, and sleep.
  '☀️','⏰','🕐','🔔','habit-image:toothbrush','habit-image:bath','🌙','💤','habit-image:bed',
  // Movement, sport, and activity.
  '🚶','🏃','habit-image:bicycle','habit-image:swim','🤸','🧘','💪','👣','🔥','🎯',
  // Measurements, wellbeing, and healthcare.
  '⚖️','📏','❤️','💝','🧠','🩺','🌡️','💊','💉',
  // Food and drinks.
  '🍽️','🍎','habit-image:grapes','🥗','habit-image:broccoli','habit-image:egg','💧','habit-image:water','habit-image:milk','☕','habit-image:tea','🍺',
  // Home, living things, shopping, and household money.
  '🏠','habit-image:clean','habit-image:laundry','habit-image:plant','🌿','habit-image:dog','🛒','💰','habit-image:receipt',
  // Work, planning, records, and learning.
  'habit-image:computer','📱','📧','📅','📋','✅','📝','habit-image:writing','🗂️','📊','📈','📉','📖','🎓',
  // Hobbies and recreation.
  '🎵','🎮','habit-image:puzzle','habit-image:movie','📸','🎨','⭐',
];
export const HABIT_ICONS = Object.freeze(ICON_ORDER.map(id => byId.get(id) || Object.freeze({id,label:id})));
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export function habitIconContents(value) {
  const item = byId.get(value);
  if (!item) return escape(value || '•');
  const x = item.index % 4 * 100 / 3;
  const y = Math.floor(item.index / 4) * 100 / 4;
  return `<span class="habit-image-icon" aria-hidden="true" style="background-position:${x}% ${y}%"></span>`;
}
export function habitIconOptions(selected) {
  return HABIT_ICONS.map(item => `<button type="button" class="icon-opt ${item.id === selected ? 'sel' : ''}" data-ic="${item.id}" aria-label="${item.label}" aria-pressed="${item.id === selected}">${habitIconContents(item.id)}</button>`).join('');
}
