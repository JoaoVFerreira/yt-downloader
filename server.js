require('dotenv').config({
    debug: process.env.NODE_ENV !== 'production'
});

const winston = require('winston');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Remover HOST fixo - deixar Express decidir
app.set('trust proxy', 1); // Adicionar trust proxy

// Middleware de validação
const validateRequiredEnv = () => {
    const required = ['NODE_ENV'];
    for (const envVar of required) {
        if (!process.env[envVar]) {
            console.error(`❌ Variável de ambiente obrigatória não encontrada: ${envVar}`);
            process.exit(1);
        }
    }
};

validateRequiredEnv();

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'youtube-downloader' },
    transports: [
        new winston.transports.File({ 
            filename: path.join(__dirname, 'logs', 'error.log'), 
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
        new winston.transports.File({ 
            filename: path.join(__dirname, 'logs', 'combined.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        })
    ]
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple()
    }));
}

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

app.use(morgan('combined', {
    stream: fs.createWriteStream(path.join(__dirname, 'logs', 'access.log'), { flags: 'a' })
}));

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
            objectSrc: ["'none'"],
            connectSrc: ["'self'"],
            upgradeInsecureRequests: [],
        },
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));

const downloadLimiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX_DOWNLOADS) || 10, // limit each IP to 10 downloads per windowMs
    message: {
        success: false,
        error: 'Muitas tentativas de download. Tente novamente em alguns minutos.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        const whitelist = process.env.RATE_LIMIT_WHITELIST?.split(',') || [];
        return whitelist.includes(req.ip);
    }
});

const generalLimiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_GENERAL_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_GENERAL_MAX) || 100, // limit each IP to 100 requests per windowMs
    message: {
        success: false,
        error: 'Muitas requisições. Tente novamente em alguns minutos.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        const whitelist = process.env.RATE_LIMIT_WHITELIST?.split(',') || [];
        return whitelist.includes(req.ip);
    }
});

app.use(generalLimiter);

app.use(express.static('public', {
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
    etag: true,
    lastModified: true
}));

app.use(express.json({ limit: '700mb' }));
app.use(express.urlencoded({ extended: true, limit: '700mb' }));

// Error handling middleware for JSON parsing
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ success: false, error: 'JSON inválido' });
    }
    next();
});

const cleanupOldFiles = () => {
    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) return;

    const maxAge = parseInt(process.env.FILE_CLEANUP_MAX_AGE_HOURS) || 24; // 24 hours
    const maxAgeMs = maxAge * 60 * 60 * 1000;

    console.log(`🧹 Iniciando limpeza de arquivos mais antigos que ${maxAge} horas...`);

    try {
        const files = fs.readdirSync(downloadsDir);
        let deletedCount = 0;

        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            const stats = fs.statSync(filePath);
            const age = Date.now() - stats.mtime.getTime();

            if (age > maxAgeMs) {
                try {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                    console.log(`🗑️ Arquivo removido: ${file}`);
                } catch (error) {
                    console.error(`❌ Erro ao remover arquivo ${file}:`, error.message);
                }
            }
        });

        if (deletedCount > 0) {
            console.log(`✅ Limpeza concluída: ${deletedCount} arquivos removidos`);
        } else {
            console.log(`✅ Limpeza concluída: nenhum arquivo antigo encontrado`);
        }
    } catch (error) {
        console.error('❌ Erro durante limpeza de arquivos:', error.message);
    }
};

const getDiskUsage = () => {
    const downloadsDir = path.join(__dirname, 'downloads');
    
    if (!fs.existsSync(downloadsDir)) {
        return { totalSize: 0, fileCount: 0 };
    }

    let totalSize = 0;
    let fileCount = 0;

    try {
        const files = fs.readdirSync(downloadsDir);
        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            const stats = fs.statSync(filePath);
            totalSize += stats.size;
            fileCount++;
        });
    } catch (error) {
        console.error('Erro ao calcular uso de disco:', error.message);
    }

    return { totalSize, fileCount };
};

cron.schedule('0 */6 * * *', cleanupOldFiles);

app.get('/', (req, res) => {
    try {
        const indexPath = path.join(__dirname, 'public', 'index.html');
        if (fs.existsSync(indexPath)) {
            res.sendFile(indexPath);
        } else {
            res.json({ 
                success: true, 
                message: 'YouTube Downloader API está funcionando!',
                endpoints: ['/download', '/health']
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro interno do servidor' });
    }
});

const validateYouTubeUrl = (url) => {
    const youtubeRegex = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]{11}/;
    return youtubeRegex.test(url);
};

app.post('/download', 
    downloadLimiter,
    async (req, res) => {
        const startTime = Date.now();
        let downloadedFile = null;
        
        try {
            const { url, format = 'mp4' } = req.body;
            
            if (!url) {
                return res.status(400).json({
                    success: false,
                    error: 'URL é obrigatória'
                });
            }
            
            if (!validateYouTubeUrl(url)) {
                return res.status(400).json({
                    success: false,
                    error: 'URL do YouTube inválida'
                });
            }
            
            if (!['mp4', 'webm', 'mp3'].includes(format)) {
                return res.status(400).json({
                    success: false,
                    error: 'Formato inválido. Use: mp4, webm ou mp3'
                });
            }
            
            console.log(`📥 Nova requisição de download: ${url} (${format})`);
            
            try {
                const result = await downloadVideoForWeb(url);
                downloadedFile = result.filename;
                
                const endTime = Date.now();
                const duration = (endTime - startTime) / 1000;
                
                console.log(`✅ Download concluído em ${duration}s: ${result.filename}`);
                
                logger.info('Download completed', {
                    url,
                    format,
                    duration,
                    filename: result.filename,
                    ip: req.ip
                });
                
                res.json({
                    success: true,
                    message: 'Download concluído com sucesso!',
                    data: {
                        filename: result.filename,
                        downloadUrl: `/download-file/${encodeURIComponent(result.filename)}`,
                        ...result.videoInfo
                    }
                });
                
            } catch (downloadError) {
                const endTime = Date.now();
                const duration = (endTime - startTime) / 1000;
                
                console.error(`❌ Erro no download após ${duration}s:`, downloadError.message);
                
                logger.error('Download failed', {
                    error: downloadError.message,
                    stack: downloadError.stack,
                    url,
                    format,
                    duration,
                    ip: req.ip
                });
                
                res.status(500).json({
                    success: false,
                    error: 'Erro interno do servidor'
                });
            }
            
        } catch (error) {
            console.error('❌ Erro na rota /download:', error);
            
            logger.error('Route error', {
                error: error.message,
                stack: error.stack,
                ip: req.ip
            });
            
            if (downloadedFile) {
                try {
                    const filePath = path.join(__dirname, 'downloads', downloadedFile);
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                } catch (cleanupError) {
                    console.error('❌ Erro ao limpar arquivo:', cleanupError.message);
                }
            }
            
            res.status(500).json({
                success: false,
                error: 'Erro interno do servidor'
            });
        }
    }
);

// Suporte para HEAD request no endpoint de download
app.head('/download-file/:filename', (req, res) => {
    try {
        const filename = decodeURIComponent(req.params.filename);
        const filePath = path.join(__dirname, 'downloads', filename);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).end();
        }
        
        const stat = fs.statSync(filePath);
        const ext = path.extname(filename).toLowerCase();
        let contentType = 'application/octet-stream';
        
        switch(ext) {
            case '.mp4':
                contentType = 'video/mp4';
                break;
            case '.webm':
                contentType = 'video/webm';
                break;
            case '.mp3':
                contentType = 'audio/mpeg';
                break;
            case '.m4a':
                contentType = 'audio/mp4';
                break;
        }
        
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.status(200).end();
        
    } catch (error) {
        console.error('❌ Erro na rota HEAD /download-file:', error);
        res.status(500).end();
    }
});

app.get('/download-file/:filename', 
    (req, res) => {
        try {
            const filename = decodeURIComponent(req.params.filename);
            const filePath = path.join(__dirname, 'downloads', filename);
            
            console.log(`📥 Requisição de download para: ${filename}`);
            console.log(`📂 Caminho do arquivo: ${filePath}`);
            
            if (!fs.existsSync(filePath)) {
                console.log('❌ Arquivo não encontrado:', filePath);
                return res.status(404).json({
                    success: false,
                    error: 'Arquivo não encontrado'
                });
            }
            
            const stat = fs.statSync(filePath);
            console.log(`📊 Tamanho do arquivo: ${stat.size} bytes`);
            
            // Detectar tipo MIME baseado na extensão
            const ext = path.extname(filename).toLowerCase();
            let contentType = 'application/octet-stream';
            
            switch(ext) {
                case '.mp4':
                    contentType = 'video/mp4';
                    break;
                case '.webm':
                    contentType = 'video/webm';
                    break;
                case '.mp3':
                    contentType = 'audio/mpeg';
                    break;
                case '.m4a':
                    contentType = 'audio/mp4';
                    break;
            }
            
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
            
            console.log('📤 Iniciando stream do arquivo...');
            const readStream = fs.createReadStream(filePath);
            
            readStream.on('error', (error) => {
                console.error('❌ Erro ao ler arquivo:', error.message);
                if (!res.headersSent) {
                    res.status(500).json({
                        success: false,
                        error: 'Erro ao ler arquivo'
                    });
                }
            });
            
            readStream.on('end', () => {
                console.log('✅ Download concluído com sucesso');
            });
            
            readStream.pipe(res);
            
        } catch (error) {
            console.error('❌ Erro na rota /download-file:', error);
            res.status(500).json({
                success: false,
                error: 'Erro interno do servidor'
            });
        }
    }
);

app.post('/cleanup-file', (req, res) => {
    try {
        const { filename } = req.body;
        
        if (!filename) {
            return res.status(400).json({
                success: false,
                error: 'Nome do arquivo é obrigatório'
            });
        }
        
        const filePath = path.join(__dirname, 'downloads', filename);
        
        console.log(`🗑️ Solicitação de limpeza para arquivo: ${filename}`);
        console.log(`📂 Caminho do arquivo: ${filePath}`);
        
        if (!fs.existsSync(filePath)) {
            console.log('⚠️ Arquivo já foi removido ou não existe:', filePath);
            return res.json({
                success: true,
                message: 'Arquivo já foi removido ou não existe'
            });
        }
        
        try {
            fs.unlinkSync(filePath);
            console.log(`✅ Arquivo removido com sucesso: ${filename}`);
            
            logger.info('File cleanup successful', {
                filename: filename,
                ip: req.ip
            });
            
            res.json({
                success: true,
                message: 'Arquivo removido com sucesso'
            });
            
        } catch (unlinkError) {
            console.error(`❌ Erro ao remover arquivo ${filename}:`, unlinkError.message);
            
            logger.error('File cleanup failed', {
                error: unlinkError.message,
                filename: filename,
                ip: req.ip
            });
            
            res.status(500).json({
                success: false,
                error: 'Erro ao remover arquivo do servidor'
            });
        }
        
    } catch (error) {
        console.error('❌ Erro na rota /cleanup-file:', error);
        
        logger.error('Cleanup route error', {
            error: error.message,
            stack: error.stack,
            ip: req.ip
        });
        
        res.status(500).json({
            success: false,
            error: 'Erro interno do servidor'
        });
    }
});

async function downloadVideoForWeb(videoUrl) {
    console.log('Verificando URL do vídeo...');
    
    try {
        // Primeira tentativa: yt-dlp (método atual)
        console.log('Tentando download via yt-dlp...');
        return await downloadViaYtDlp(videoUrl);
    } catch (error) {
        console.log('yt-dlp falhou:', error.message);
        
        // Se foi erro de bot detection, tenta Invidious
        if (error.message.includes('Sign in to confirm') || 
            error.message.includes('bot') || 
            error.message.includes('age')) {
            
            console.log('Tentando download via Invidious...');
            return await downloadViaInvidious(videoUrl);
        } else {
            // Outros erros não relacionados a bloqueio
            throw error;
        }
    }
}

async function downloadViaYtDlp(videoUrl) {
    const fs = require('fs');
    const path = require('path');
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    function sanitizeFilename(filename) {
        return filename.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
    }
    
    const downloadsDir = path.join(__dirname, 'downloads');
    
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }
    
    // Detectar comando yt-dlp
    const isProduction = process.env.NODE_ENV === 'production';
    let ytDlpCommand;
    
    if (isProduction) {
        const ytdlpOptions = ['yt-dlp', 'python3 -m yt_dlp', '/opt/venv/bin/yt-dlp'];
        
        for (const cmd of ytdlpOptions) {
            try {
                await execAsync(`${cmd} --version`, { timeout: 5000 });
                ytDlpCommand = cmd;
                console.log(`yt-dlp encontrado via: ${cmd}`);
                break;
            } catch (e) {
                continue;
            }
        }
        
        if (!ytDlpCommand) {
            throw new Error('yt-dlp não encontrado');
        }
    } else {
        ytDlpCommand = './yt-dlp';
    }
    
    // Obter informações do vídeo
    console.log('Obtendo informações do vídeo...');
    const infoCommand = `${ytDlpCommand} --dump-single-json --no-warnings "${videoUrl}"`;
    
    const { stdout: infoOutput } = await execAsync(infoCommand, {
        cwd: downloadsDir,
        timeout: 30000
    });
    
    const info = JSON.parse(infoOutput);
    if (!info) throw new Error('Não foi possível obter informações do vídeo');
    
    console.log(`Título: ${info.title}`);
    console.log(`Autor: ${info.uploader || info.channel || 'N/A'}`);
    
    const sanitizedTitle = sanitizeFilename(info.title) || `video_${info.id}_${Date.now()}`;
    const outputTemplate = `${sanitizedTitle}.%(ext)s`;
    
    // Headers anti-bot
    const commonArgs = [
        '--user-agent', '"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"',
        '--add-header', '"Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"',
        '--no-warnings'
    ].join(' ');
    
    // Estratégias de download
    const downloadStrategies = [
        `${ytDlpCommand} ${commonArgs} --format "best[ext=mp4][height<=1080]/best" --output "${outputTemplate}" "${videoUrl}"`,
        `${ytDlpCommand} ${commonArgs} --format "worst[ext=mp4]/worst" --output "${outputTemplate}" "${videoUrl}"`
    ];
    
    let downloadSuccess = false;
    let lastError = null;
    
    for (let i = 0; i < downloadStrategies.length; i++) {
        try {
            console.log(`Tentativa ${i + 1}/${downloadStrategies.length}...`);
            
            if (i > 0) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            await execAsync(downloadStrategies[i], {
                cwd: downloadsDir,
                timeout: 300000
            });
            
            downloadSuccess = true;
            console.log(`Download bem-sucedido na tentativa ${i + 1}`);
            break;
        } catch (error) {
            lastError = error;
            console.log(`Tentativa ${i + 1} falhou`);
        }
    }
    
    if (!downloadSuccess) {
        throw lastError || new Error('Todas as estratégias falharam');
    }
    
    // Encontrar arquivo baixado
    const files = fs.readdirSync(downloadsDir)
        .filter(file => file.startsWith(sanitizedTitle))
        .sort((a, b) => fs.statSync(path.join(downloadsDir, b)).mtime - fs.statSync(path.join(downloadsDir, a)).mtime);
    
    if (files.length === 0) {
        throw new Error('Arquivo não foi criado');
    }
    
    const downloadedFile = files[0];
    const downloadedPath = path.join(downloadsDir, downloadedFile);
    
    if (!fs.existsSync(downloadedPath) || fs.statSync(downloadedPath).size === 0) {
        throw new Error('Arquivo vazio ou corrompido');
    }
    
    // Formatar duração
    const duration = parseInt(info.duration) || 0;
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    const durationString = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    
    return {
        filename: downloadedFile,
        videoInfo: {
            title: info.title,
            author: info.uploader || info.channel || 'N/A',
            duration: durationString,
            views: info.view_count ? parseInt(info.view_count).toLocaleString() : 'N/A',
            quality: info.height ? `${info.height}p` : 'N/A',
            method: 'yt-dlp'
        }
    };
}

async function downloadViaInvidious(videoUrl) {
    const fs = require('fs');
    const path = require('path');
    
    function sanitizeFilename(filename) {
        return filename.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
    }
    
    function formatDuration(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    
    const videoId = extractVideoId(videoUrl);
    if (!videoId) throw new Error('URL inválida');
    
    const instances = [
        'https://yewtu.be',
        'https://invidious.nerdvpn.de',
        'https://inv.nadeko.net',
        'https://invidious.f5.si',
        'https://invidious.kavin.rocks',
        'https://invidious.io',
        'https://inv.riverside.rocks'
    ];
    
    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }
    
    for (const instance of instances) {
        try {
            console.log(`Tentando instância: ${instance}`);
            
            // Obter dados do vídeo
            const response = await fetch(`${instance}/api/v1/videos/${videoId}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 10000
            });
            
            if (!response.ok) continue;
            
            const data = await response.json();
            
            if (data.error) {
                console.log(`Erro da API: ${data.error}`);
                continue;
            }
            
            // Escolher melhor formato disponível
            let format = data.formatStreams?.find(f => 
                f.container === 'mp4' && f.qualityLabel && parseInt(f.qualityLabel) <= 720
            );
            
            // Fallback para qualquer formato MP4
            if (!format) {
                format = data.formatStreams?.find(f => f.container === 'mp4');
            }
            
            if (!format) {
                console.log('Nenhum formato MP4 disponível nesta instância');
                continue;
            }
            
            console.log(`Formato selecionado: ${format.qualityLabel || 'N/A'}`);
            
            // Download direto
            const videoResponse = await fetch(format.url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            if (!videoResponse.ok) {
                console.log(`Falha no download: ${videoResponse.status}`);
                continue;
            }
            
            const buffer = await videoResponse.arrayBuffer();
            
            // Salvar arquivo
            const filename = `${sanitizeFilename(data.title)}.mp4`;
            const filepath = path.join(downloadsDir, filename);
            fs.writeFileSync(filepath, Buffer.from(buffer));
            
            console.log('Download via Invidious concluído');
            
            return {
                filename,
                videoInfo: {
                    title: data.title,
                    author: data.author,
                    duration: formatDuration(data.lengthSeconds),
                    views: data.viewCount ? parseInt(data.viewCount).toLocaleString() : 'N/A',
                    quality: format.qualityLabel || 'N/A',
                    method: 'Invidious'
                }
            };
            
        } catch (error) {
            console.log(`Instância ${instance} falhou: ${error.message}`);
            continue;
        }
    }
    
    throw new Error('Todas as instâncias Invidious falharam');
}

function extractVideoId(youtubeUrl) {
    const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/;
    const match = youtubeUrl.match(regex);
    return match ? match[1] : null;
}

app.get('/health', (_, res) => {
    const { totalSize, fileCount } = getDiskUsage();
    
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        diskUsage: {
            totalSize: `${(totalSize / 1024 / 1024).toFixed(2)} MB`,
            fileCount
        },
        environment: process.env.NODE_ENV,
        version: process.env.npm_package_version || '1.0.0'
    });
});

app.all('*', (_, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint não encontrado'
    });
});

app.use((err, _req, res, _next) => {
    console.error('❌ Erro não tratado:', err);
    
    logger.error('Unhandled error', {
        error: err.message,
        stack: err.stack
    });
    
    if (res.headersSent) {
        return;
    }
    
    const isDevelopment = process.env.NODE_ENV !== 'production';
    
    res.status(500).json({
        success: false,
        error: isDevelopment ? err.message : 'Erro interno do servidor',
        ...(isDevelopment && { stack: err.stack })
    });
});

process.on('uncaughtException', (err) => {
    console.error('❌ Exceção não capturada:', err);
    logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
    
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rejeitada não tratada:', reason, 'Promise:', promise);
    logger.error('Unhandled Promise Rejection', { reason, promise });
});

// Remover HOST fixo - deixar Express decidir automaticamente
const server = app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log('📁 Interface web disponível!');
    console.log('🛡️  Segurança habilitada: Rate limiting, Helmet, Validação');
    console.log('📊 Logs estruturados habilitados');
    
    if (process.env.NODE_ENV !== 'production') {
        console.log('⚠️  Modo desenvolvimento ativo');
    }
});

server.keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT) || 65000;
server.headersTimeout = parseInt(process.env.HEADERS_TIMEOUT) || 66000;

process.on('SIGTERM', () => {
    console.log('🛑 Recebido SIGTERM, fechando servidor...');
    server.close(() => {
        console.log('✅ Servidor fechado graciosamente');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 Recebido SIGINT, fechando servidor...');
    server.close(() => {
        console.log('✅ Servidor fechado graciosamente');
        process.exit(0);
    });
});

module.exports = app;