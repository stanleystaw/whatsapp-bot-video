// Déobfusqueur : exécute le code obfusqué dans un sandbox, récupère la
// fonction de décodage des chaînes, et remplace tous les appels
// _0xXXXX(0xNNN) par la vraie chaîne en clair.
import fs from 'node:fs'
import vm from 'node:vm'

const [,, file, aliasName] = process.argv
if (!file || !aliasName) {
  console.error('Usage: node deobf.mjs <file> <aliasName>')
  process.exit(1)
}
const src = fs.readFileSync(file, 'utf8')

// Stubs pour les requires du code (axios / fs-extra)
const axiosStub = {
  get: async () => ({ data: [], status: 200 }),
  post: async () => ({ data: {}, status: 200 }),
}
const fsStub = new Proxy(
  {},
  {
    get: () => async (..._a) => ({ size: 0, isFile: () => false }),
  }
)
const requireStub = (name) => {
  if (name === 'axios') return axiosStub
  if (name === 'fs-extra' || name === 'fs') return fsStub
  if (name === 'path') return import('node:path').then((m) => m.default).catch(() => null)
  return {}
}
const sandbox = {
  require: requireStub,
  module: { exports: {} },
  console,
  Buffer,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  global: {},
  Promise,
  Error,
  Array,
  Object,
  String,
  Number,
  Math,
  Set,
  JSON,
  parseInt,
  parseFloat,
  decodeURIComponent,
  encodeURIComponent,
  RegExp,
  Date,
  isNaN,
  Infinity,
  undefined: undefined,
}
const ctx = vm.createContext(sandbox)

// 1) Exécution du code (remplit le shuffle de l'array de chaînes)
vm.runInContext(src, ctx)

// 2) La fonction de décodage est l'alias racine ; le code crée des sous-alias
// (const _0xZZZZ = _0xYYYY ;). On collecte tous les alias (point fixe).
const getStr = (idx) => vm.runInContext(`${aliasName}(${idx})`, ctx)
const aliases = new Set([aliasName])
let changed = true
while (changed) {
  changed = false
  for (const m of src.matchAll(/const (_0x[0-9a-f]+)\s*=\s*(_0x[0-9a-f]+)\s*;/g)) {
    const [, x, y] = m
    if (aliases.has(y) && !aliases.has(x)) {
      aliases.add(x)
      changed = true
    }
  }
}

// 3) Remplace tous les appels alias(0xNNN) par la chaîne décodée
let out = src
let count = 0
for (const id of aliases) {
  out = out.replace(new RegExp(`\\b${id}\\((0x[0-9a-f]+)\\)`, 'g'), (m, hex) => {
    try {
      count++
      return JSON.stringify(getStr(hex))
    } catch {
      return m
    }
  })
}

// 4) Nettoyage cosmétique : supprime la grosse IIFE de shuffle et la table de chaînes
const fnMatch = src.match(/function _0x\w+\(\)\{const _0x\w+=\[[\s\S]*?\];_0x\w+=function\(\)\{return _0x\w+\};return _0x\w+\(\);\}/)
if (fnMatch) out = out.replace(fnMatch[0], '/* table de chaînes obfusquées supprimée */')
const iifeMatch = src.match(/^\(function\(_0x\w+,\s*_0x\w+\)\{[\s\S]*?\}\(_0x\w+,\s*0x[0-9a-f]+\)\);/)
if (iifeMatch) out = out.replace(iifeMatch[0], '/* shuffle supprimé */')

fs.writeFileSync(file.replace(/\.js$/, '.deobf.js'), out)
console.log(`OK ${file} → ${file.replace(/\.js$/, '.deobf.js')} (${count} chaînes décodées)`)
