// Helper: fetch with timeout
function fetchWithTimeout(url, options = {}, timeout = 30000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout')), timeout)
    )
  ]);
}

export default async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const { url, format = 'mp4', quality = '720' } = req.method === 'GET' ? req.query : req.body;

  if (!url) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'URL parameter is required' }));
    return;
  }

  const isValidYouTube = url.includes('youtube.com') || url.includes('youtu.be');
  if (!isValidYouTube) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Invalid YouTube URL' }));
    return;
  }

  try {
    const result = await downloadVideo(url, format, quality);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    
    if (result.direct) {
      res.end(JSON.stringify({
        success: true,
        url: result.url,
        filename: result.filename,
        source: result.source,
        quality: result.quality
      }));
    } else if (result.streamUrl) {
      res.end(JSON.stringify({
        success: true,
        url: result.streamUrl,
        filename: result.filename,
        source: result.source,
        isStream: true
      }));
    } else {
      res.end(JSON.stringify(result));
    }
  } catch (error) {
    console.error('Download error:', error);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 500;
    res.end(JSON.stringify({ 
      error: 'Download failed',
      message: error.message
    }));
  }
}

async function downloadVideo(url, format, quality) {
  // Try Cobalt API (primary - works for most videos)
  try {
    const result = await tryCobalt(url, format, quality);
    return { ...result, direct: true };
  } catch (e) {
    console.warn('Cobalt failed:', e.message);
  }

  // Try OpenUtils (secondary - bypasses age-restriction)
  try {
    const result = await tryOpenUtils(url, format, quality);
    if (result) return { ...result, direct: false };
  } catch (e) {
    console.warn('OpenUtils failed:', e.message);
  }

  // Try YT-Download.org (tertiary fallback)
  try {
    const result = await tryYtDownload(url, format, quality);
    return { ...result, direct: true };
  } catch (e) {
    console.warn('YT-Download failed:', e.message);
  }

  throw new Error('All download methods failed. The video may be age-restricted, private, region-locked, or too long.');
}

async function tryCobalt(url, format, quality) {
  const body = {
    url,
    filenameStyle: 'pretty',
    youtubeVideoCodec: 'h264'
  };

  if (format === 'audio') {
    body.downloadMode = 'audio';
    body.audioFormat = 'mp3';
    body.audioBitrate = '128';
  } else if (format === 'mute') {
    body.downloadMode = 'mute';
    body.videoQuality = quality === 'max' ? '2160' : quality;
  } else {
    body.downloadMode = 'auto';
    body.videoQuality = quality === 'max' ? '2160' : quality;
    body.youtubeHLS = false;
  }

  try {
    const response = await fetchWithTimeout('https://api.cobalt.tools/api/json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Cobalt API HTTP ${response.status}`);
    }

    const data = await response.json();
    
    if (data.status === 'error') {
      throw new Error(data.error?.message || data.error?.code || 'Cobalt API error');
    }

    const dlUrl = data.url || (Array.isArray(data.picker) && data.picker[0]?.url);
    if (!dlUrl) {
      throw new Error('No download URL in Cobalt response');
    }

    return {
      url: dlUrl,
      filename: data.filename || `youtube_video.${format === 'audio' ? 'mp3' : 'mp4'}`,
      source: 'Cobalt',
      quality: quality
    };
  } catch (e) {
    if (e.message.includes('timeout')) throw new Error('Cobalt request timed out');
    throw e;
  }
}

async function tryOpenUtils(url, format, quality) {
  const isAudio = format === 'audio';
  const qualityMap = {
    '360': 'mp4-360',
    '480': 'mp4-480',
    '720': 'mp4-720',
    '1080': 'mp4-1080',
    'max': 'mp4-1080',
    'best': 'mp4-1080'
  };
  
  const fmtParam = isAudio ? 'mp3' : (qualityMap[quality] || 'mp4-720');
  const endpoint = isAudio
    ? `https://ytdl.openutils.net/api/stream?url=${encodeURIComponent(url)}`
    : `https://ytdl.openutils.net/api/stream/video?url=${encodeURIComponent(url)}&fmt=${fmtParam}`;

  try {
    const response = await fetchWithTimeout(endpoint, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error(`OpenUtils HTTP ${response.status}`);
    }

    // Verify it's a media stream, not error JSON
    const contentType = response.headers.get('content-type') || '';
    const isMedia = contentType.includes('video') || contentType.includes('audio') || contentType.includes('octet-stream');
    
    if (!isMedia) {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        if (json.error) throw new Error(json.error);
      } catch {
        throw new Error('OpenUtils returned non-media response');
      }
    }

    return {
      streamUrl: endpoint,
      filename: `youtube_video.${isAudio ? 'mp3' : 'mp4'}`,
      source: 'OpenUtils',
      quality: quality
    };
  } catch (e) {
    if (e.message.includes('timeout')) throw new Error('OpenUtils request timed out');
    throw e;
  }
}

async function tryYtDownload(url, format, quality) {
  const params = new URLSearchParams({
    url: url,
    format: format === 'audio' ? 'mp3' : 'mp4',
    quality: quality === 'max' ? 'best' : quality
  });

  try {
    const response = await fetchWithTimeout(`https://yt-download.org/api/?${params}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error(`YT-Download HTTP ${response.status}`);
    }

    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error);
    }

    const dlUrl = data.download_url || data.url || data.link;
    if (!dlUrl) {
      throw new Error('No download URL in YT-Download response');
    }

    return {
      url: dlUrl,
      filename: data.filename || `youtube_video.${format === 'audio' ? 'mp3' : 'mp4'}`,
      source: 'YT-Download.org',
      quality: quality
    };
  } catch (e) {
    if (e.message.includes('timeout')) throw new Error('YT-Download request timed out');
    throw e;
  }
}
