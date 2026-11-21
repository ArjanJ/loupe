// The fake model for test/pipeline.mjs: answers each Loupe prompt with JSON of the shape it asks for.
export function answer(prompt) {
  const schema = prompt.slice(prompt.lastIndexOf('Schema: {"'));
  if (schema.startsWith('Schema: {"package"')) {
    const files = [...prompt.matchAll(/^(\S+\.(?:js|mjs|ts)) \(\d+ loc/gm)].map((m) => m[1]);
    return { package: { label: 'Fixture App', shortDescription: 'A tiny app.', longDescription: 'Server, client and a helper.' }, modules: [{ key: 'core', label: 'Core', shortDescription: 'Everything.', longDescription: 'All files.', files }] };
  }
  if (schema.startsWith('Schema: {"files"')) {
    const files = [...prompt.matchAll(/^### (\S+) \(/gm)].map((m) => m[1]);
    return { files: Object.fromEntries(files.map((f) => [f, { label: f.split('/').pop().replace(/\.\w+$/, ''), shortDescription: `Stub file ${f}.`, longDescription: 'Stub.', functions: [] }])) };
  }
  if (schema.startsWith('Schema: {"label"')) return { label: 'Stub System', shortDescription: 'A stub-described system.', longDescription: 'Described by the test stub.' };
  if (schema.startsWith('Schema: {"pairs"')) {
    const pairs = [...prompt.matchAll(/^(\S+) -> (\S+) \|/gm)];
    return { pairs: Object.fromEntries(pairs.map((m) => [`${m[1]} -> ${m[2]}`, { label: 'stub link', summary: 'Stub summary.' }])) };
  }
  if (schema.startsWith('Schema: {"flows"')) {
    const ids = [...prompt.matchAll(/^(\S+) = "/gm)].map((m) => m[1]);
    const steps = ids.length >= 2 ? [{ from: ids[0], to: ids[1], kind: 'import', text: 'calls it' }, { from: ids[1], to: ids[0], kind: 'import', text: 'answers' }] : [];
    return { flows: [{ id: 'stub-flow', title: 'Stub flow', summary: 'A flow from the stub.', steps }] };
  }
  return {};
}
