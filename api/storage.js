// Storage backends for snapshots and saved analyses. Both expose the same synchronous interface.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const SAFE_ID = /^(snap|an)_[0-9a-f]{16}$/;

export class FileStorage {
  constructor(dataDir) {
    this.snapDir = join(dataDir, 'snapshots');
    this.anDir = join(dataDir, 'analyses');
    mkdirSync(this.snapDir, { recursive: true });
    mkdirSync(this.anDir, { recursive: true });
  }
  #read(dir, id) {
    if (!SAFE_ID.test(id)) return null;
    const f = join(dir, `${id}.json`);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf8'));
  }
  #write(dir, id, obj) {
    if (!SAFE_ID.test(id)) throw new Error(`unsafe id ${id}`);
    const f = join(dir, `${id}.json`);
    writeFileSync(f + '.tmp', JSON.stringify(obj, null, 2) + '\n');
    renameSync(f + '.tmp', f); // atomic replace
  }
  #list(dir) {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }
  getSnapshot(id) { return this.#read(this.snapDir, id); }
  putSnapshot(s) { this.#write(this.snapDir, s.id, s); }
  listSnapshots() { return this.#list(this.snapDir); }
  getAnalysis(id) { return this.#read(this.anDir, id); }
  putAnalysis(a) { this.#write(this.anDir, a.id, a); }
  listAnalyses() { return this.#list(this.anDir); }
}

export { MemoryStorage } from './memory-storage.js';
