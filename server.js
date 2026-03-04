const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright-chromium');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache de URLs extraídas - guarda resultados por 1 hora
const urlCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hora en ms

app.use(cors());
app.use(express.json());

// =============================================
// HEALTH CHECK (Railway lo necesita)
// =============================================
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Sonance Movies Extractor API',
        version: '1.0.0',
        endpoints: {
            extract: 'GET /extract?id=MOVIE_ID&type=movie|tv',
            cached: 'GET /cache-status'
        }
    });
});

app.get('/cache-status', (req, res) => {
    res.json({ cached_entries: urlCache.size });
});

// =============================================
// ENDPOINT PRINCIPAL: EXTRACCIÓN DE VIDEO
// =============================================
app.get('/extract', async (req, res) => {
    const { id, type = 'movie', season, episode } = req.query;

    if (!id) {
        return res.status(400).json({ error: 'Se requiere el parámetro "id".' });
    }

    // Buscar en caché primero
    const cacheKey = `${type}_${id}_${season || ''}_${episode || ''}`;
    if (urlCache.has(cacheKey)) {
        const cached = urlCache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            console.log(`[CACHE HIT] ${cacheKey}`);
            return res.json({ url: cached.url, source: 'cache' });
        }
        urlCache.delete(cacheKey); // Expirado, eliminar
    }

    console.log(`[EXTRAYENDO] Tipo: ${type}, ID: ${id}`);

    let browser = null;
    let streamUrl = null;

    // Construir URL según tipo de contenido
    let embedUrl;
    if (type === 'tv') {
        embedUrl = `https://vsembed.ru/embed/tv/${id}/${season || 1}/${episode || 1}?autoplay=1`;
    } else {
        embedUrl = `https://vsembed.ru/embed/movie/${id}?autoplay=1`;
    }

    // Lista de fuentes alternativas (si vsembed falla)
    const sources = [
        embedUrl,
        `https://vidsrc.xyz/embed/movie?tmdb=${id}`,
        `https://www.2embed.cc/embed/${id}`
    ];

    for (const sourceUrl of sources) {
        if (streamUrl) break;

        try {
            console.log(`[INTENTANDO] ${sourceUrl}`);
            browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--autoplay-policy=no-user-gesture-required'
                ]
            });

            const context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Linux; Android 10; BRAVIA 4K; Build/PPR1.180610.011) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Safari/537.36',
                viewport: { width: 1920, height: 1080 }
            });

            const page = await context.newPage();

            // Interceptar peticiones de red buscando el stream
            page.on('request', request => {
                const url = request.url();
                if (!streamUrl && (url.includes('.m3u8') || url.includes('.mp4'))) {
                    // Filtrar thumbnails/posters que también pueden ser .mp4 pequeños
                    if (!url.includes('thumb') && !url.includes('poster') && !url.includes('preview')) {
                        streamUrl = url;
                        console.log(`[ENCONTRADO] Stream URL: ${url.substring(0, 80)}...`);
                    }
                }
            });

            await page.goto(sourceUrl, {
                waitUntil: 'networkidle',
                timeout: 15000
            });

            // Intentar hacer clic en botón de play
            await page.waitForTimeout(2000);
            await page.evaluate(() => {
                const selectors = [
                    '.plyr__control--overlaid',
                    '.vjs-big-play-button',
                    '.play-button',
                    '#play-target',
                    'button[class*="play"]',
                    'div[class*="play"]'
                ];
                for (const sel of selectors) {
                    const btn = document.querySelector(sel);
                    if (btn) { btn.click(); break; }
                }
                // También intentar reproducir el elemento video directamente
                const vid = document.querySelector('video');
                if (vid) vid.play().catch(() => { });
            });

            // Esperar más tiempo para que cargue el stream
            await page.waitForTimeout(5000);

            await browser.close();
            browser = null;

        } catch (err) {
            console.error(`[ERROR] Fuente ${sourceUrl}: ${err.message}`);
            if (browser) {
                await browser.close();
                browser = null;
            }
        }
    }

    if (!streamUrl) {
        return res.status(404).json({
            error: 'No se pudo extraer la URL del stream.',
            hint: 'El servidor del video bloqueó la extracción o el ID es incorrecto.',
            id,
            type
        });
    }

    // Guardar en caché
    urlCache.set(cacheKey, { url: streamUrl, timestamp: Date.now() });

    console.log(`[OK] Enviando URL al app para ID: ${id}`);
    return res.json({
        url: streamUrl,
        source: 'live',
        id,
        type
    });
});

app.listen(PORT, () => {
    console.log(`✅ Sonance Scraper API corriendo en puerto ${PORT}`);
});
