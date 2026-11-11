// Browser-safe in-memory storage (used by tests and the hosted build).
export class MemoryStorage {
  constructor({ snapshots = [], analyses = [] } = {}) {
    this.s = new Map(snapshots.map((x) => [x.id, structuredClone(x)]));
    this.a = new Map(analyses.map((x) => [x.id, structuredClone(x)]));
  }
  getSnapshot(id) { return this.s.has(id) ? structuredClone(this.s.get(id)) : null; }
  putSnapshot(x) { this.s.set(x.id, structuredClone(x)); }
  listSnapshots() { return [...this.s.values()]; }
  getAnalysis(id) { return this.a.has(id) ? structuredClone(this.a.get(id)) : null; }
  putAnalysis(x) { this.a.set(x.id, structuredClone(x)); }
  listAnalyses() { return [...this.a.values()]; }
}
