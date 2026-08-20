// 公共小工具
export function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

export function dirname(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '' : normalized.slice(0, idx);
}

export function joinPath(dir: string, rel: string): string {
  if (dir === '') return rel;
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + rel : dir + '/' + rel;
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatTime(ms: number | null): string {
  if (ms === null) return '';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function hex(n: number, width: number): string {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

export function formatBytesHex(n: number | null): string {
  if (n === null) return '—';
  return `0x${hex(n, 8)}`;
}
