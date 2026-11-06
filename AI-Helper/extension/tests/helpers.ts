import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { recognizeDom } from '../src/content/recognize';

export const PAGES = resolve(__dirname, '..', '..', 'test-pages');

/** Loads a test page into the jsdom document (scripts are not executed). */
export function loadPage(name: string): Document {
  const html = readFileSync(resolve(PAGES, name), 'utf-8');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  return document;
}

export function recognizeAll(doc: Document = document) {
  return recognizeDom(doc, { inRegion: () => true });
}
