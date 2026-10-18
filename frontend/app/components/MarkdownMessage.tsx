"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownMessageProps = {
  content: string;
};

function getPipeCells(line: string): string[] | null {
  const value = line.trim();

  if (!value.startsWith("|") || !value.endsWith("|")) {
    return null;
  }

  return value
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = getPipeCells(line);

  return (
    cells !== null &&
    cells.length > 1 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

function normalizeMarkdown(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];

  let index = 0;
  let insideCodeFence = false;
  let codeFenceMarker = "";

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    const fenceMatch = trimmed.match(/^(```+|~~~+)/);

    if (fenceMatch) {
      const marker = fenceMatch[1];

      if (!insideCodeFence) {
        insideCodeFence = true;
        codeFenceMarker = marker.slice(0, 3);
      } else if (marker.startsWith(codeFenceMarker)) {
        insideCodeFence = false;
        codeFenceMarker = "";
      }

      output.push(line);
      index++;
      continue;
    }

    if (insideCodeFence || getPipeCells(line) === null) {
      output.push(line);
      index++;
      continue;
    }

    const tableRows: string[] = [];

    while (
      index < lines.length &&
      getPipeCells(lines[index]) !== null
    ) {
      tableRows.push(lines[index]);
      index++;
    }

    const firstRowCells = getPipeCells(tableRows[0]);

    const consistentColumnCount =
      firstRowCells !== null &&
      firstRowCells.length > 1 &&
      tableRows.every(
        (row) => getPipeCells(row)?.length === firstRowCells.length,
      );

    const hasHeaderSeparator =
      tableRows.length > 1 && isTableSeparator(tableRows[1]);

    if (
      tableRows.length >= 2 &&
      consistentColumnCount &&
      !hasHeaderSeparator
    ) {
      const columnCount = firstRowCells!.length;

      const headers = [
        "Aspect",
        ...Array.from(
          { length: columnCount - 1 },
          (_, column) => `Option ${column + 1}`,
        ),
      ];

      output.push(`| ${headers.join(" | ")} |`);
      output.push(
        `| ${headers.map(() => "---").join(" | ")} |`,
      );
      output.push(...tableRows);
    } else {
      output.push(...tableRows);
    }
  }

  return output.join("\n");
}

const markdownComponents: Components = {
  a({ href, children, ...props }) {
    const isExternal =
      typeof href === "string" && /^https?:\/\//i.test(href);

    return (
      <a
        href={href}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        {...props}
      >
        {children}
      </a>
    );
  },

  table({ children, ...props }) {
    return (
      <div className="markdown-table-wrap">
        <table {...props}>{children}</table>
      </div>
    );
  },
};

export default function MarkdownMessage({
  content,
}: MarkdownMessageProps) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {normalizeMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
}