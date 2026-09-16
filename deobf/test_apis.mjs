// Test des APIs des plugins ytb.js / dl.js
const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

async function probe(name, url, { timeout = 120000, headers = {} } = {}) {
  const t0 = Date.now()
  try {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), timeout)
    const res = await fetch(url, { signal: ctrl.signal, headers, redirect: 'follow' })
    clearTimeout(to)
    const ct = res.headers.get('content-type') || ''
    const isJson = ct.includes('json')
    let body = ''
    if (isJson) {
      body = (await res.text()).slice(0, 1200)
    } else {
      const buf = Buffer.from(await res.arrayBuffer())
      body = `[BINAIRE ${buf.length} octets]`
      if (buf.length < 400) body += ' ' + buf.toString('utf8').slice(0, 300)
    }
    console.log(`\n=== ${name} ===`)
    console.log(`URL      : ${url}`)
    console.log(`HTTP     : ${res.status} | ${Math.round((Date.now() - t0) / 1000)}s | ${ct}`)
    console.log(`BODY     : ${body}`)
    return { status: res.status, body, ct }
  } catch (e) {
    console.log(`\n=== ${name} ===`)
    console.log(`URL      : ${url}`)
    console.log(`ERREUR   : ${e.message} après ${Math.round((Date.now() - t0) / 1000)}s`)
    return null
  }
}

console.log('### 1. apischristus.vercel.app — recherche')
await probe('search/youtube', 'https://apischristus.vercel.app/api/search/youtube?q=chat+dr%C3%B4le&limit=6')

console.log('\n### 2. apischristus.vercel.app — download/youtube')
await probe('download/youtube', `https://apischristus.vercel.app/api/download/youtube?url=${encodeURIComponent(YT_URL)}`, { timeout: 170000 })

console.log('\n### 3. apischristus.vercel.app — auto (YouTube)')
await probe('auto (yt)', `https://apischristus.vercel.app/api/auto?url=${encodeURIComponent(YT_URL)}`, { timeout: 170000 })

console.log('\n### 4. downloader-christus.onrender.com — supported')
await probe('supported', 'https://downloader-christus.onrender.com/api/supported', { timeout: 120000 })

console.log('\n### 5. downloader-christus.onrender.com — auto (YouTube)')
await probe('auto (yt)', `https://downloader-christus.onrender.com/api/auto?url=${encodeURIComponent(YT_URL)}`, { timeout: 170000 })
