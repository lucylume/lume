const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const ffmpeg = require('fluent-ffmpeg');
const ytdl = require('@distube/ytdl-core');

// Configuration FFmpeg pour Railway
const ffmpegPath = require('fluent-ffmpeg');
try {
    ffmpegPath.setFfmpegPath('/usr/bin/ffmpeg');
    ffmpegPath.setFfprobePath('/usr/bin/ffprobe');
    console.log('✅ FFmpeg configuré pour Railway');
} catch (error) {
    console.log('⚠️ FFmpeg path non défini, utilisation par défaut');
}
const { pipeline } = require('@xenova/transformers');
const wav = require('node-wav');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Configuration simple
const CONFIG = {
    TEMP_DIR: './temp',
    OUTPUT_DIR: './output'
};

let whisperModel = null;

// Initialiser Whisper FRANÇAIS MEDIUM
async function initWhisper() {
    try {
        console.log('🇫🇷 Initialisation Whisper différée pour économiser RAM...');
        // Ne pas charger Whisper au démarrage - le charger à la demande
        console.log('✅ Whisper sera chargé à la première utilisation');
    } catch (error) {
        console.error('❌ Erreur:', error);
        whisperModel = null;
    }
}

// Créer dossiers
async function initDirs() {
    await fs.mkdir(CONFIG.TEMP_DIR, { recursive: true });
    await fs.mkdir(CONFIG.OUTPUT_DIR, { recursive: true });
}

// API UNIQUE QUI FAIT TOUT
app.post('/api/convert', async (req, res) => {
    const timeout = setTimeout(() => {
        res.status(408).json({
            success: false,
            error: 'Timeout - Opération trop longue (limite 5 minutes)'
        });
    }, 5 * 60 * 1000); // 5 minutes timeout

    try {
        const { url, duration = 30 } = req.body;
        console.log(`🎬 Conversion: ${url} (${duration}s)`);

        // Vérifier URL YouTube
        if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
            clearTimeout(timeout);
            return res.status(400).json({
                success: false,
                error: 'URL YouTube valide requise'
            });
        }

        if (!whisperModel) {
            console.log('⏳ Chargement Whisper à la demande...');
            whisperModel = await pipeline(
                'automatic-speech-recognition',
                'Xenova/whisper-tiny',
                { 
                    quantized: true,
                    device: 'cpu'
                }
            );
            console.log('✅ Whisper chargé !');
        }

        // 1. TÉLÉCHARGEMENT avec gestion d'erreur améliorée
        console.log('📥 Téléchargement...');
        let info, videoId, filename, videoPath;
        
        try {
            console.log('🔍 Test accès YouTube...');
            info = await ytdl.getInfo(url);
            console.log('✅ Accès YouTube OK');
            
            videoId = ytdl.getVideoID(url);
            filename = `${videoId}_${Date.now()}`;
            videoPath = path.join(CONFIG.TEMP_DIR, `${filename}.mp4`);
            
            console.log(`🎬 Vidéo: ${info.videoDetails.title}`);
            console.log(`⏱️ Durée: ${info.videoDetails.lengthSeconds}s`);
            
            console.log('🔍 Test FFmpeg disponible...');
            const { spawn } = require('child_process');
            const ffmpegTest = spawn('ffmpeg', ['-version']);
            
            await new Promise((resolve, reject) => {
                ffmpegTest.on('close', (code) => {
                    if (code === 0) {
                        console.log('✅ FFmpeg disponible');
                        resolve();
                    } else {
                        console.log('❌ FFmpeg non disponible');
                        reject(new Error('FFmpeg non trouvé'));
                    }
                });
                ffmpegTest.on('error', () => {
                    console.log('❌ FFmpeg erreur');
                    reject(new Error('FFmpeg erreur'));
                });
            });
            
            console.log('📥 Début téléchargement...');
            const stream = ytdl(url, { 
                quality: 'lowest', // Commencer par la plus basse qualité
                filter: 'videoandaudio',
                requestOptions: {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                }
            });
            
            const writeStream = require('fs').createWriteStream(videoPath);
            stream.pipe(writeStream);
            
            await new Promise((resolve, reject) => {
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
                stream.on('error', reject);
            });
            console.log('✅ Téléchargement terminé');
        } catch (error) {
            console.error('❌ Erreur détaillée:', error);
            throw new Error(`Échec: ${error.message}`);
        }

        // 2. SEGMENT ALÉATOIRE
        const totalDuration = parseInt(info.videoDetails.lengthSeconds);
        const startTime = Math.random() * Math.max(0, totalDuration - duration);
        console.log(`✂️ Segment: ${startTime.toFixed(1)}s → ${(startTime + duration).toFixed(1)}s`);

        // 3. EXTRACTION AUDIO POUR WHISPER
        console.log('🎵 Extraction audio...');
        const audioPath = path.join(CONFIG.TEMP_DIR, `${filename}_audio.wav`);
        await new Promise((resolve, reject) => {
            ffmpeg(videoPath)
                .seekInput(startTime)
                .duration(duration)
                .audioChannels(1)
                .audioFrequency(16000)
                .audioCodec('pcm_s16le')
                .output(audioPath)
                .on('end', resolve)
                .on('error', reject)
                .run();
        });
        console.log('✅ Audio extrait');

        // 4. TRANSCRIPTION FRANÇAISE WHISPER MEDIUM
        console.log('🎤 Transcription française Whisper medium...');
        const buffer = await fs.readFile(audioPath);
        const result = wav.decode(buffer);
        const audioData = new Float32Array(result.channelData[0]);
        
        const transcription = await whisperModel(audioData, {
            language: 'french',  // FORCER LE FRANÇAIS
            task: 'transcribe',
            return_timestamps: true,
            chunk_length_s: 6,    // Segments plus courts pour précision
            stride_length_s: 1    // Moins de chevauchement
        });

        console.log(`📝 Transcription: "${transcription.text}"`);
        console.log('✅ Transcription terminée');

        // 5. CRÉATION SRT AVEC SYNCHRONISATION INTELLIGENTE
        console.log('📄 Création sous-titres synchronisés...');
        const srtPath = path.join(CONFIG.TEMP_DIR, `${filename}.srt`);
        
        // Utiliser les VRAIS timestamps de Whisper !
        console.log('🔍 Debug transcription structure:');
        console.log('- Text:', transcription.text);
        console.log('- Chunks count:', transcription.chunks?.length || 0);
        
        let srtContent = '';
        let segmentIndex = 1;
        
        if (transcription.chunks && transcription.chunks.length > 0) {
            // Utiliser les timestamps RÉELS de Whisper
            console.log('✅ Utilisation des timestamps Whisper réels');
            
            for (const chunk of transcription.chunks) {
                if (chunk.timestamp && chunk.text) {
                    const [startTime, endTime] = chunk.timestamp;
                    let text = chunk.text.trim();
                    
                    if (text && startTime !== null && endTime !== null) {
                        // Découper en mots courts pour style TikTok (max 3-4 mots)
                        const words = text.split(' ');
                        if (words.length > 4) {
                            // Créer plusieurs segments courts
                            for (let i = 0; i < words.length; i += 3) {
                                const segmentWords = words.slice(i, Math.min(i + 3, words.length));
                                const segmentText = segmentWords.join(' ');
                                const segmentDuration = (endTime - startTime) / Math.ceil(words.length / 3);
                                const segmentStart = startTime + (i / 3) * segmentDuration;
                                const segmentEnd = Math.min(segmentStart + segmentDuration, endTime);
                                
                                console.log(`⏱️ Segment ${segmentIndex}: "${segmentText}" (${segmentStart.toFixed(1)}s-${segmentEnd.toFixed(1)}s)`);
                                
                                srtContent += `${segmentIndex}\n`;
                                srtContent += `${formatSRTTime(segmentStart)} --> ${formatSRTTime(segmentEnd)}\n`;
                                srtContent += `${segmentText}\n\n`;
                                segmentIndex++;
                            }
                        } else {
                            console.log(`⏱️ Segment ${segmentIndex}: "${text}" (${startTime.toFixed(1)}s-${endTime.toFixed(1)}s)`);
                            
                            srtContent += `${segmentIndex}\n`;
                            srtContent += `${formatSRTTime(startTime)} --> ${formatSRTTime(endTime)}\n`;
                            srtContent += `${text}\n\n`;
                            segmentIndex++;
                        }
                    }
                }
            }
        } else {
            // Fallback si pas de chunks
            console.log('⚠️ Pas de chunks Whisper, utilisation fallback');
            const words = transcription.text.split(/\s+/).filter(w => w.length > 0);
            const wordsPerSegment = 3; // Max 3 mots par ligne TikTok
            
            for (let i = 0; i < words.length; i += wordsPerSegment) {
                const segmentWords = words.slice(i, Math.min(i + wordsPerSegment, words.length));
                const segmentPosition = i / words.length;
                const startTime = segmentPosition * duration;
                const endTime = Math.min(startTime + 1.8, duration); // Plus court pour style TikTok
                
                srtContent += `${segmentIndex}\n`;
                srtContent += `${formatSRTTime(startTime)} --> ${formatSRTTime(endTime)}\n`;
                srtContent += `${segmentWords.join(' ')}\n\n`;
                segmentIndex++;
            }
        }
        
        await fs.writeFile(srtPath, srtContent, 'utf8');
        console.log('✅ Sous-titres créés');

        // 6. RENDU FINAL TIKTOK AVEC LYRICS
        const finalPath = path.join(CONFIG.OUTPUT_DIR, `tiktok_${filename}.mp4`);
        console.log('🎬 Rendu final TikTok avec lyrics intégrés...');
        
        await new Promise((resolve, reject) => {
            ffmpeg(videoPath)
                .seekInput(startTime)
                .duration(duration)
                .videoFilters([
                    'scale=1080:1920:force_original_aspect_ratio=increase',
                    'crop=1080:1920',
                    `subtitles=${srtPath}:force_style='FontName=Arial Black,FontSize=16,PrimaryColour=&H00FFFF,OutlineColour=&H000000,Outline=1,Shadow=0,Bold=1,Alignment=2,MarginV=20,BorderStyle=1'`
                ])
                .videoCodec('libx264')
                .videoBitrate('2500k')
                .fps(30)
                .audioCodec('aac')
                .audioBitrate('128k')
                .addOptions(['-preset', 'fast', '-crf', '23'])
                .output(finalPath)
                .on('end', resolve)
                .on('error', reject)
                .run();
        });
        console.log('✅ Rendu final terminé');

        // 7. NETTOYAGE
        await fs.unlink(videoPath).catch(() => {});
        await fs.unlink(audioPath).catch(() => {});
        await fs.unlink(srtPath).catch(() => {});

        console.log('🎉 TikTok généré avec succès !');
        clearTimeout(timeout);
        res.json({
            success: true,
            downloadUrl: `/output/tiktok_${filename}.mp4`,
            transcription: transcription.text,
            videoTitle: info.videoDetails.title,
            duration: duration,
            segment: `${startTime.toFixed(1)}s-${(startTime + duration).toFixed(1)}s`
        });

    } catch (error) {
        console.error('❌ Erreur complète:', error);
        clearTimeout(timeout);
        
        // Réponse d'erreur détaillée
        let errorMessage = error.message;
        if (error.message.includes('ytdl')) {
            errorMessage = 'YouTube bloque l\'accès - Essayez une autre vidéo';
        } else if (error.message.includes('ffmpeg')) {
            errorMessage = 'Problème de traitement vidéo - Service indisponible';
        } else if (error.message.includes('ENOENT')) {
            errorMessage = 'Fichier introuvable - Erreur serveur';
        }
        
        res.status(500).json({ 
            success: false,
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Servir les fichiers
app.use('/output', express.static(CONFIG.OUTPUT_DIR));

// Page principale  
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

function formatSRTTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

// Démarrage
async function start() {
    await initDirs();
    await initWhisper();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Lume - TikTok Creator sur port ${PORT}`);
        console.log('🇫🇷 Whisper français tiny activé (Railway optimisé)');
        console.log(`📡 Serveur accessible sur 0.0.0.0:${PORT}`);
    });
}

start().catch(console.error);