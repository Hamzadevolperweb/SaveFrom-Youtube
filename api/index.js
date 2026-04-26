export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { url, format = 'mp4', quality = '720' } = req.method === 'GET' ? req.query : req.body;

  if (!url) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(400).json({ error: 'URL parameter is required' });
    return;
  }

  // Validate YouTube URL
  const isValidYouTube = url.includes('youtube.com') || url.includes('youtu.be');
  if (!isValidYouTube) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(400).json({ error: 'Invalid YouTube URL' });
    return;
  }

  try {
    // Try different download methods
    const result = await downloadVideo(url, format, quality);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    
    if (result.direct) {
      // For direct download URLs, return JSON with the URL
      res.status(200).json({
        success: true,
        url: result.url,
        filename: result.filename,
        source: result.source,
        quality: result.quality
      });
    } else if (result.streamUrl) {
      // For stream-based APIs, return redirect URL
      res.status(200).json({
        success: true,
        url: result.streamUrl,
        filename: result.filename,
        source: result.source,
        isStream: true
      });
    }
  } catch (error) {
    console.error('Download error:', error);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({ 
      error: 'Download failed',
      message: error.message,
      code: error.code
    });
  }
}

async function downloadVideo(url, format, quality) {
  // Method 1: Try Cobalt API (handles most videos)
  try {
    const cobaltResult = await tryCobalt(url, format, quality);
    return { ...cobaltResult, direct: true };
  } catch (e) {
    console.warn('Cobalt failed:', e.message);
  }

  // Method 2: Try OpenUtils stream API
  try {
    const openUtilsResult = await tryOpenUtils(url, format, quality);
    if (openUtilsResult) return { ...openUtilsResult, direct: false };
  } catch (e) {
    console.warn('OpenUtils failed:', e.message);
  }

  // Method 3: Try YT-Download API
  try {
    const ytDownloadResult = await tryYtApi(url, format, quality);
    return { ...ytDownloadResult, direct: true };
  } catch (e) {
    console.warn('YT-Download API failed:', e.message);
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

  const response = await fetch('https://api.cobalt.tools/api/json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
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

  // Test if API is accessible
  const testResponse = await fetch(endpoint, {
    method: 'HEAD',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!testResponse.ok) {
    throw new Error(`OpenUtils HTTP ${testResponse.status}`);
  }

  return {
    streamUrl: endpoint,
    filename: `youtube_video.${isAudio ? 'mp3' : 'mp4'}`,
    source: 'OpenUtils',
    quality: quality
  };
}

async function tryYtApi(url, format, quality) {
  // YT-Download API alternative
  const apiEndpoint = 'https://yt-download.org/api/';
  const params = new URLSearchParams({
    url: url,
    format: format === 'audio' ? 'mp3' : 'mp4',
    quality: quality === 'max' ? 'best' : quality
  });

  const response = await fetch(`${apiEndpoint}?${params}`, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`YT-Download API HTTP ${response.status}`);
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
}


      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, corsHeaders);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const { url, format, quality } = req.query;

  if (!url) {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'URL parameter is required' }));
    return;
  }

  // Validate YouTube URL
  const isValidYouTube = url.includes('youtube.com') || url.includes('youtu.be');
  if (!isValidYouTube) {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid YouTube URL' }));
    return;
  }

  try {
    // Try multiple APIs in sequence
    const result = await tryDownloadAPIs(url, format, quality);
    
    res.writeHead(200, { 
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    });
    res.end(JSON.stringify(result));
  } catch (error) {
    console.error('Download error:', error);
    res.writeHead(500, { 
      ...corsHeaders,
      'Content-Type': 'application/json'
    });
    res.end(JSON.stringify({ 
      error: 'Download failed',
      message: error.message,
      fallbackUrl: `https://youtube.com/watch?v=${extractVideoId(url)}`
    }));
  }
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('?')[0];
    return u.searchParams.get('v');
  } catch {
    return null;
  }
}

async function tryDownloadAPIs(url, format, quality) {
  // API 1: OpenUtils (most reliable free API)
  try {
    const result = await tryOpenUtils(url, format, quality);
    if (result) return { ...result, source: 'OpenUtils API' };
  } catch (e) {
    console.warn('OpenUtils failed:', e.message);
  }

  // API 2: Cobalt (secondary option)
  try {
    const result = await tryCobaltAPI(url, format, quality);
    if (result) return { ...result, source: 'Cobalt API' };
  } catch (e) {
    console.warn('Cobalt failed:', e.message);
  }

  // API 3: yt-download.org
  try {
    const result = await tryYtDownloadOrg(url, format, quality);
    if (result) return { ...result, source: 'YT-Download.org' };
  } catch (e) {
    console.warn('YT-Download.org failed:', e.message);
  }

  throw new Error('All download APIs failed. The video may be age-restricted, private, or region-locked.');
}

async function tryOpenUtils(url, format, quality) {
  const isAudio = format === 'audio';
  const formatParam = isAudio ? 'mp3' : `mp4-${quality === 'max' ? '1080' : quality || '720'}`;
  const endpoint = isAudio 
    ? `https://ytdl.openutils.net/api/stream?url=${encodeURIComponent(url)}`
    : `https://ytdl.openutils.net/api/stream/video?url=${encodeURIComponent(url)}&fmt=${formatParam}`;

  const response = await fetchUrl(endpoint, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (response.statusCode !== 200) {
    throw new Error(`OpenUtils HTTP ${response.statusCode}`);
  }

  // For stream endpoints, we need to get the actual download URL
  // OpenUtils returns the file directly, so we need to convert to a blob URL
  // But since this is a serverless function, we can't easily store files
  // Instead, we'll redirect to the stream URL
  
  return {
    type: 'redirect',
    url: endpoint,
    filename: `video.${isAudio ? 'mp3' : 'mp4'}`,
    size: response.headers['content-length'] || 'unknown'
  };
}

async function tryCobaltAPI(url, format, quality) {
  const body = {
    url,
    filenameStyle: 'pretty',
    youtubeVideoCodec: 'h264',
    downloadMode: format === 'audio' ? 'audio' : format === 'mute' ? 'mute' : 'auto',
    ...(format !== 'audio' && { 
      videoQuality: quality === 'max' ? '2160' : (quality || '720'),
      youtubeHLS: false 
    })
  };

  if (format === 'audio') {
    body.audioFormat = 'mp3';
    body.audioBitrate = '128';
  }

  const response = await fetchUrl('https://api.cobalt.tools/api/json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (response.statusCode !== 200) {
    throw new Error(`Cobalt HTTP ${response.statusCode}`);
  }

  const data = JSON.parse(response.body);
  
  if (data.status === 'error') {
    throw new Error(data.error?.message || data.error?.code || 'Cobalt API error');
  }

  const dlUrl = data.url || (Array.isArray(data.picker) && data.picker[0]?.url);
  if (!dlUrl) {
    throw new Error('No download URL in response');
  }

  return {
    type: 'direct',
    url: dlUrl,
    filename: data.filename || `video.${format === 'audio' ? 'mp3' : 'mp4'}`,
    size: data.size || 'unknown'
  };
}

async function tryYtDownloadOrg(url, format, quality) {
  const isAudio = format === 'audio';
  const apiUrl = `https://yt-download.org/api/?url=${encodeURIComponent(url)}&format=${isAudio ? 'mp3' : 'mp4'}&quality=${quality === 'max' ? 'best' : (quality || '720')}`;

  const response = await fetchUrl(apiUrl, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (response.statusCode !== 200) {
    throw new Error(`YT-Download.org HTTP ${response.statusCode}`);
  }

  const data = JSON.parse(response.body);
  if (data.error) {
    throw new Error(data.error);
  }

  const dlUrl = data.download_url || data.url || data.link;
  if (!dlUrl) {
    throw new Error('No download URL in response');
  }

  return {
    type: 'direct',
    url: dlUrl,
    filename: data.filename || `video.${isAudio ? 'mp3' : 'mp4'}`,
    size: data.size || 'unknown'
  };
}
