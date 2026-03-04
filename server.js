const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache de URLs - TTL 2 horas
const urlCache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;

app.use(cors());
app.use(express.json());

// =============================================
// HEALTH CHECK
// =============================================
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Sonance Movies API',
        version: '2.0.0',
        note: 'Direct API mode - no scraping needed'
    });
});

// =============================================
// ENDPOINT: URL DEL EMBED (para iframe o ExoPlayer)
// No scrapeamos - devolvemos el embed URL ya construido
// que la app usa directamente
// =============================================
app.get('/embed', (req, res) => {
    const { id, type = 'movie', season = 1, episode = 1 } = req.query;

    if (!id) {
        return res.status(400).json({ error: 'Falta el parámetro id' });
    }

    // Sources por prioridad - todas con autoplay nativo
    let embedUrl;
    if (type === 'tv') {
        embedUrl = `https://vidsrc.me/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`;
    } else {
        embedUrl = `https://vidsrc.me/embed/movie?tmdb=${id}`;
    }

    res.json({ embedUrl, id, type });
});

// =============================================  
// ENDPOINT: EXTRACCIÓN DIRECTA (API key pública de vidsrc.xyz)
// vidsrc.xyz expone un API JSON que da el stream directo
// =============================================
app.get('/extract', async (req, res) => {
    const { id, type = 'movie', season = 1, episode = 1 } = req.query;

    if (!id) {
        return res.status(400).json({ error: 'Falta el parámetro id' });
    }

    const cacheKey = `${type}_${id}_s${season}_e${episode}`;
    if (urlCache.has(cacheKey)) {
        const c = urlCache.get(cacheKey);
        if (Date.now() - c.timestamp < CACHE_TTL) {
            return res.json({ ...c.data, source: 'cache' });
        }
        urlCache.delete(cacheKey);
    }

    // Intentar con vidsrc API directa
    const apiSources = [];

    if (type === 'tv') {
        apiSources.push(
            `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`,
            `https://vidsrc.me/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`
        );
    } else {
        apiSources.push(
            `https://vidsrc.xyz/embed/movie?tmdb=${id}`,
            `https://vidsrc.me/embed/movie?tmdb=${id}`,
            `https://player.smashy.stream/movie/${id}`,
            `https://multiembed.mov/?video_id=${id}&tmdb=1`
        );
    }

    // Intentar cada source, devolver el primer embed URL que responda con 200
    for (const url of apiSources) {
        try {
            const resp = await fetch(url, {
                method: 'HEAD',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; BRAVIA 4K) AppleWebKit/537.36 Chrome/90.0 Safari/537.36',
                    'Referer': 'https://www.google.com/'
                },
                signal: AbortSignal.timeout(5000)
            });

            if (resp.ok || resp.status === 200 || resp.status === 301 || resp.status === 302) {
                const data = {
                    embedUrl: url,
                    directUrl: null,
                    id,
                    type,
                    note: 'Embed URL - usar en ExoPlayer o iframe'
                };
                urlCache.set(cacheKey, { data, timestamp: Date.now() });
                return res.json({ ...data, source: 'live' });
            }
        } catch (e) {
            console.log(`[SKIP] ${url}: ${e.message}`);
        }
    }

    // Si ninguna responde, devolver la primera de todas formas (puede funcionar en la app)
    const fallbackUrl = apiSources[0];
    res.json({
        embedUrl: fallbackUrl,
        directUrl: null,
        id, type,
        source: 'fallback',
        note: 'No se pudo verificar disponibilidad, usando URL principal'
    });
});

app.listen(PORT, () => {
    console.log(`✅ Sonance API v2.0 corriendo en puerto ${PORT}`);
});
