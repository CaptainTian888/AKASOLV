(() => {
  const releaseApi = 'https://api.github.com/repos/captainzeqi/Captain-Net-Releases/releases/latest';
  const toast = document.querySelector('.download-toast');
  let timer;
  const wireDownloadLinks = () => document.querySelectorAll('[data-download]').forEach((link) => {
    link.addEventListener('click', () => {
      toast.classList.add('show');
      clearTimeout(timer);
      timer = setTimeout(() => toast.classList.remove('show'), 3200);
    });
  });
  wireDownloadLinks();

  fetch(releaseApi, { headers: { Accept: 'application/vnd.github+json' } })
    .then((response) => response.ok ? response.json() : Promise.reject(response.status))
    .then((release) => {
      const asset = (release.assets || []).find((item) => /^CaptainNet-v.*\.exe$/i.test(item.name));
      if (!asset) return;
      document.querySelectorAll('[data-download]').forEach((link) => { link.href = asset.browser_download_url; });
    })
    .catch(() => {
      document.querySelectorAll('[data-download]').forEach((link) => { link.href = 'https://github.com/captainzeqi/Captain-Net-Releases/releases/latest'; });
    });

  const reveal = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        reveal.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.feature-card,.step,.section-heading').forEach((item) => {
    item.classList.add('reveal');
    reveal.observe(item);
  });
})();
