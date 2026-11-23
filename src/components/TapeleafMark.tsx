export function TapeleafMark() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <circle cx="12.5" cy="16" r="5" stroke="var(--canvas)" strokeWidth="2" />
      <circle cx="12.5" cy="16" r="1.6" fill="var(--vermilion)" />
      <path
        d="M19.5 11.5v9M23 13.5v5"
        stroke="var(--canvas)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
