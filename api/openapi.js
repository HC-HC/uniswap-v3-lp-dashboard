// Minimal OpenAPI 3.1 description of the API, generated from the input schema.
import { INPUT_SCHEMA, INPUT_DEFAULTS } from '../engine/validate.js';
import { ENGINE_VERSION } from '../engine/analysis.js';

export function buildOpenApi() {
  const props = {};
  for (const [k, v] of Object.entries(INPUT_SCHEMA)) {
    props[k] = v.type === 'array'
      ? { type: 'array', items: { type: 'number', minimum: v.items.min, maximum: v.items.max }, maxItems: v.maxItems, description: v.doc, default: INPUT_DEFAULTS[k] }
      : { type: v.type, minimum: v.min, maximum: v.max, pattern: v.pattern ? v.pattern.source : undefined, description: v.doc, default: INPUT_DEFAULTS[k] };
  }
  const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  const body = (ref) => ({ required: true, content: { 'application/json': { schema: { $ref: ref } } } });
  const ok = (d) => ({ description: d, content: { 'application/json': {} } });
  const idParam = (name) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
  return {
    openapi: '3.1.0',
    info: { title: 'Uniswap v3 LP Dashboard API', version: ENGINE_VERSION, description: 'Uniswap v3 WETH/USDC range analysis on content-addressed data snapshots. Every output field is tagged observed | derived | estimated | assumed.' },
    paths: {
      '/api/health': { get: { summary: 'Liveness and capabilities', responses: { 200: ok('ok') } } },
      '/api/schema': { get: { summary: 'Input schema, defaults, assumptions, provenance legend', responses: { 200: ok('schema') } } },
      '/api/snapshots': {
        get: { summary: 'List snapshots (newest first)', responses: { 200: ok('list') } },
        post: { summary: 'Import a raw snapshot; it is validated and content-addressed', requestBody: body('#/components/schemas/RawSnapshot'), responses: { 200: ok('already present'), 201: ok('created'), 422: err } },
      },
      '/api/snapshots/refresh': { post: { summary: 'Fetch live data (GeckoTerminal + optional RPC) into a new snapshot', responses: { 201: ok('created'), 502: err, 503: err } } },
      '/api/snapshots/{id}': { get: { summary: "Full snapshot ('latest' allowed)", parameters: [idParam('id')], responses: { 200: ok('snapshot'), 404: err, 409: err } } },
      '/api/snapshots/{id}/market': { get: { summary: 'Derived market inputs with provenance', parameters: [idParam('id'), { name: 'volumePolicy', in: 'query', schema: { type: 'string' } }], responses: { 200: ok('market') } } },
      '/api/analyze': { post: { summary: 'Run an analysis without saving it', requestBody: body('#/components/schemas/AnalyzeRequest'), responses: { 200: ok('report'), 404: err, 422: err } } },
      '/api/tiers': { post: { summary: 'Compare fee tiers: the same range analysed in each WETH/USDC pool (newest snapshot per tier, or compareSnapshotIds)', requestBody: body('#/components/schemas/AnalyzeRequest'), responses: { 200: ok('tier comparison'), 404: err, 422: err } } },
      '/api/analyses': {
        get: { summary: 'List saved analyses', responses: { 200: ok('list') } },
        post: { summary: 'Run and save an analysis. The id is determined by (snapshot, inputs, engine version), so saving twice returns the same id.', requestBody: body('#/components/schemas/AnalyzeRequest'), responses: { 200: ok('existing'), 201: ok('created'), 422: err } },
      },
      '/api/analyses/{id}': { get: { summary: 'Saved analysis with result', parameters: [idParam('id')], responses: { 200: ok('analysis'), 404: err } } },
      '/api/analyses/{id}/replay': { post: { summary: 'Recompute from the stored snapshot and inputs and compare result hashes', parameters: [idParam('id')], responses: { 200: ok('replay'), 404: err, 409: err } } },
      '/api/analyses/{id}/bundle': { get: { summary: 'Portable bundle (inputs + snapshot) for reproducing elsewhere', parameters: [idParam('id')], responses: { 200: ok('bundle') } } },
      '/api/bundles/import': { post: { summary: 'Import a bundle, verify hashes, and replay it', responses: { 200: ok('replay'), 409: err, 422: err } } },
    },
    components: {
      schemas: {
        Inputs: { type: 'object', required: ['capitalUsd'], additionalProperties: false, properties: props },
        AnalyzeRequest: { type: 'object', properties: { snapshotId: { type: 'string', description: "snapshot id or 'latest'" }, inputs: { $ref: '#/components/schemas/Inputs' }, label: { type: 'string' } }, required: ['inputs'] },
        RawSnapshot: { type: 'object', description: 'See data/raw/*.json for the format' },
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } } },
      },
    },
  };
}
