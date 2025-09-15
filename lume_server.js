const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const ffmpeg = require('fluent-ffmpeg');
const ytdl = require('@distube/ytdl-core');
const { pipeline } = require('@xenova/transformers');
const wav = require('node-wav');

const app = express();
const PORT = process.env.PORT || 3001;

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
        console.log('🇫🇷 Initialisation Whisper français medium...');
        whisperModel = await pipeline(
            'automatic-speech-recognition',
            'Xenova/whisper-small',
            { 
                quantized: false,
                device: 'cpu'
            }
        );
        console.log('✅ Whisper français medium initialisé !');
    } catch (error) {
        console.error('❌ Erreur Whisper:', error);
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
    try {
        const { url, duration = 30 } = req.body;
        console.log(`🎬 Conversion: ${url} (${duration}s)`);

        if (!whisperModel) {
            console.log('⏳ Whisper non initialisé, attendre...');
            await initWhisper();
        }

        // 1. TÉLÉCHARGEMENT
        console.log('📥 Téléchargement...');
        const info = await ytdl.getInfo(url);
        const videoId = ytdl.getVideoID(url);
        const filename = `${videoId}_${Date.now()}`;
        const videoPath = path.join(CONFIG.TEMP_DIR, `${filename}.mp4`);
        
        const stream = ytdl(url, { quality: 'highest', filter: 'videoandaudio' });
        const writeStream = require('fs').createWriteStream(videoPath);
        stream.pipe(writeStream);
        
        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
        console.log('✅ Téléchargement terminé');

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
        res.json({
            success: true,
            downloadUrl: `/output/tiktok_${filename}.mp4`,
            transcription: transcription.text,
            videoTitle: info.videoDetails.title,
            duration: duration,
            segment: `${startTime.toFixed(1)}s-${(startTime + duration).toFixed(1)}s`
        });

    } catch (error) {
        console.error('❌ Erreur:', error);
        res.status(500).json({ 
            success: false,
            error: error.message 
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
    
    app.listen(PORT, () => {
        console.log(`🚀 TikTok Auto Creator SIMPLE sur http://localhost:${PORT}`);
        console.log('🇫🇷 Whisper français medium activé');
    });
}

start().catch(console.error);