const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE = new Map();
const TTL = 3 * 60 * 60 * 1000; // 3 horas

app.use(cors());

const TV_UA = 'Mozilla/5.0 (Linux; Android 10; BRAVIA 4K; Build/PPR1.180610.011) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Safari/537.36';

app.get('/', (req, res) => res.json({ status: 'online', version: '3.0.0' }));

// =============================================
// /stream?id=TMDB_ID&type=movie|tv
// Devuelve la URL .m3u8 directa para ExoPlayer
// =============================================
app.get('/stream', async (req, res) => {
    const { id, type = 'movie', season = 1, episode = 1 } = req.query;
    if (!id) return res.status(400).json({ error: 'Falta id' });

    const key = `${type}_${id}_s${season}_e${episode}`;
    const cached = CACHE.get(key);
    if (cached && Date.now() - cached.ts < TTL) {
        return res.json({ ...cached.data, cached: true });
    }

    // ---- Fuentes de API que devuelven JSON con la URL del stream ----
    const apiFetchers = [
        () => fetchVidsrcXyz(id, type, season, episode),
        () => fetchVidSrcTo(id, type, season, episode),
        () => fetchSmashyStream(id, type, season, episode),
    ];

    let result = null;
    for (const fetcher of apiFetchers) {
        try {
            result = await fetcher();
            if (result && result.url) break;
        } catch (e) {
            console.error('[ERROR]', e.message);
        }
    }

    if (!result || !result.url) {
        // Fallback: devolver embed URL para que la app use iframe
        const embedUrl = type === 'tv'
            ? `https://vidsrc.me/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`
            : `https://vidsrc.me/embed/movie?tmdb=${id}`;
        return res.json({ url: null, embedUrl, fallback: true });
    }

    CACHE.set(key, { data: result, ts: Date.now() });
    res.json(result);
});

// ---- vidsrc.xyz tiene API JSON pública ----
async function fetchVidsrcXyz(id, type, season, episode) {
    // vidsrc.xyz expone los providers vía su API interna
    const base = type === 'tv'
        ? `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`
        : `https://vidsrc.xyz/embed/movie?tmdb=${id}`;

    const html = await fetchHtml(base);
    // Buscar la URL del m3u8 o mp4 en el HTML/JS de la página
    const m3u8Match = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
    const mp4Match = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
    const url = m3u8Match?.[0] || mp4Match?.[0] || null;
    return url ? { url, source: 'vidsrc.xyz' } : null;
}

// ---- vidsrc.to tiene API de providers ----
async function fetchVidSrcTo(id, type, season, episode) {
    // Endpoint de providers de vidsrc.to
    const apiUrl = type === 'tv'
        ? `https://vidsrc.to/vapi/source/tmdb-tv/${id}/${season}/${episode}`
        : `https://vidsrc.to/vapi/source/tmdb-movie/${id}`;

    const resp = await fetch(apiUrl, {
        headers: {
            'User-Agent': TV_UA,
            'Referer': 'https://vidsrc.to/',
            'Origin': 'https://vidsrc.to'
        },
        signal: AbortSignal.timeout(8000)
    });

    if (!resp.ok) return null;
    const data = await resp.json();

    // Intentar extraer URL del primer provider disponible
    const sources = data?.result?.sources || data?.sources || [];
    for (const src of sources) {
        if (src.url && (src.url.includes('.m3u8') || src.url.includes('.mp4'))) {
            return { url: src.url, source: 'vidsrc.to', label: src.label };
        }
    }
    return null;
}

// ---- smashy.stream tiene API JSON ----
async function fetchSmashyStream(id, type, season, episode) {
    const apiUrl = type === 'tv'
        ? `https://player.smashy.stream/tv/${id}?s=${season}&e=${episode}`
        : `https://player.smashy.stream/movie/${id}`;

    const html = await fetchHtml(apiUrl);
    const match = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
    return match ? { url: match[0], source: 'smashy.stream' } : null;
}

async function fetchHtml(url) {
    const resp = await fetch(url, {
        headers: {
            'User-Agent': TV_UA,
            'Accept': 'text/html,*/*',
            'Accept-Language': 'es-ES,es;q=0.9',
            'Referer': 'https://www.google.com/'
        },
        signal: AbortSignal.timeout(10000)
    });
    return resp.text();
}

app.listen(PORT, () => console.log(`✅ Sonance Stream API v3.0 en puerto ${PORT}`));
