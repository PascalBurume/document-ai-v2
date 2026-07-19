/** "3 min ago", "yesterday" — relative time for the library cards. */
export function formatWhen(savedAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - savedAt) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
