import { useToasts } from '../stores/toast';

const STYLE: Record<string, string> = {
  success: 'bg-emerald-600',
  error: 'bg-red-600',
  info: 'bg-neutral-700',
};

export function ToastContainer() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);

  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50 max-w-md">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`${STYLE[t.kind]} text-white text-sm px-4 py-2.5 rounded shadow-lg
            flex items-start gap-2 cursor-pointer break-all`}
          onClick={() => dismiss(t.id)}
        >
          <span className="shrink-0">
            {t.kind === 'success' ? '✓' : t.kind === 'error' ? '✕' : 'ℹ'}
          </span>
          <span className="whitespace-pre-wrap">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
