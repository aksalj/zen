
// ---- Experimental settings to try make zen faster
pref("media.memory_cache_max_size", 1048576);
pref("media.cache_readahead_limit", 9000);
pref("media.cache_resume_threshold", 3600);
pref("media.memory_caches_combined_limit_kb", 2560000);

pref("image.mem.decode_bytes_at_a_time", 32768);

// Enable GPU by default
pref("gfx.canvas.accelerated", true);
pref("media.hardware-video-decoding.enabled", true);
pref("layers.gpu-process.enabled", true);

// Prefetching:
pref("network.dns.disablePrefetch", false);
pref("network.prefetch-next", true);
pref("network.dns.disablePrefetchFromHTTPS", false);
pref("network.predictor.enable-hover-on-ssl", true);
pref("network.http.rcwn.enabled", false);

// Experimental Zen Features
// Strategy to use for bytecode cache (Thanks https://github.com/gunir)
pref('dom.script_loader.bytecode_cache.strategy', 2);
pref("layout.css.grid-template-masonry-value.enabled", true);

// No Proxy should be default, Use system proxy allows antivirus, virus or system proxy to MITM or slowing down Zen
pref("network.proxy.type", 0);
