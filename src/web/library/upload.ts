// Open a PDF from the file picker or from a drop: upload it, then open it.
import * as api from '../api/client.ts';
import { navigateToDoc } from '../app/router.ts';
import { showNotice } from '../app/session.ts';

export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/** Opens the system file picker. Resolves with null when the user cancels. */
export function pickPdfFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

export async function openFile(file: File): Promise<void> {
  if (!isPdf(file)) return showNotice(`${file.name} is not a PDF.`);
  showNotice(`Opening ${file.name}…`, 10_000);
  try {
    const d = await api.uploadDoc(file);
    showNotice(`Opened ${d.title}.`);
    await navigateToDoc(d.id);
  } catch (err) {
    showNotice(`Cannot open ${file.name}: ${err instanceof Error ? err.message : String(err)}`, 5000);
  }
}

export async function pickAndOpen(): Promise<void> {
  const file = await pickPdfFile();
  if (file) await openFile(file);
}
