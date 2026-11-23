import { useMemo } from 'react';
import { Check, Copy, FileText } from 'lucide-react';

export function MarkdownPreview({
  markdown,
  filename,
  copied,
  onCopy,
}: {
  markdown: string;
  filename: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const lines = useMemo(() => markdown.trimEnd().split('\n'), [markdown]);

  let inFrontmatter = false;
  let frontmatterClosed = false;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--code-bg)] overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-3.5 py-2 bg-[var(--panel)]">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
          <span className="truncate font-mono text-[11.5px] text-[var(--ink-secondary)]">
            {filename}
          </span>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 rounded border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--ink)] hover:bg-[var(--surface-hover)] transition-colors shrink-0 cursor-pointer"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <pre className="p-4 sm:p-5 text-[13px] leading-[1.72] font-mono overflow-x-auto whitespace-pre-wrap break-words text-[var(--ink)]">
        {lines.map((line, index) => {
          if (index === 0 && line === '---') {
            inFrontmatter = true;
            return (
              <div key={index} className="text-[var(--ink-muted)]">
                {line}
              </div>
            );
          }
          if (inFrontmatter && !frontmatterClosed && line === '---') {
            inFrontmatter = false;
            frontmatterClosed = true;
            return (
              <div key={index} className="text-[var(--ink-muted)]">
                {line}
              </div>
            );
          }

          if (inFrontmatter) {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0 && !line.startsWith('  - ')) {
              const key = line.slice(0, colonIdx + 1);
              const val = line.slice(colonIdx + 1);
              return (
                <div key={index}>
                  <span className="text-[var(--ink-muted)]">{key}</span>
                  <span className="text-[var(--ink-secondary)]">{val}</span>
                </div>
              );
            }
            return (
              <div key={index} className="text-[var(--ink-secondary)]">
                {line}
              </div>
            );
          }

          if (line.startsWith('# ') || line.startsWith('## ')) {
            return (
              <div key={index} className="font-semibold text-[var(--ink)]">
                {line}
              </div>
            );
          }
          if (line.startsWith('> ')) {
            return (
              <div key={index} className="text-[var(--ink-secondary)]">
                {line}
              </div>
            );
          }
          if (line.startsWith('![[')) {
            return (
              <div
                key={index}
                className="text-[var(--ink-muted)] underline decoration-dotted underline-offset-4"
              >
                {line}
              </div>
            );
          }
          if (line.startsWith('<!--')) {
            return (
              <div key={index} className="text-[var(--ink-muted)]/70">
                {line}
              </div>
            );
          }
          const speakerMatch = line.match(/^(\*\*[^*\n]+:\*\*)(.*)$/);
          if (speakerMatch) {
            return (
              <div key={index} className="text-[var(--ink)]">
                <span className="font-semibold text-[var(--ink)]">{speakerMatch[1]}</span>
                <span>{speakerMatch[2]}</span>
              </div>
            );
          }
          return (
            <div key={index} className="text-[var(--ink)]">
              {line || '\u00A0'}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
