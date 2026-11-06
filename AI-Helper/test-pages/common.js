// Shows the live form state, so you can see that the extension really changed the inputs
// and that change events fired. Also records clicks on the "finish" button: the extension
// must never press it.
window.__events = 0;
window.__submitted = false;

function renderState() {
  const el = document.getElementById('state');
  if (!el) return;
  const data = {};
  document.querySelectorAll('input, select, textarea').forEach((i) => {
    const key = i.name || i.id;
    if (!key || i.type === 'submit' || i.type === 'button') return;
    if (i.type === 'radio') {
      if (i.checked) data[key] = i.value;
      else if (!(key in data)) data[key] = null;
    } else if (i.type === 'checkbox') data[key + (i.name.endsWith('[]') ? '=' + i.value : '')] = i.checked;
    else data[key] = i.value;
  });
  document.querySelectorAll('[role=radio], [role=checkbox]').forEach((i) => {
    if (i.getAttribute('aria-checked') === 'true') data[i.id] = true;
  });
  el.textContent = 'change events: ' + window.__events + '\n' + JSON.stringify(data, null, 2);
}

document.addEventListener('change', () => { window.__events++; renderState(); }, true);
document.addEventListener('input', () => renderState(), true);
document.addEventListener('DOMContentLoaded', () => {
  renderState();
  document.querySelectorAll('.finish').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      window.__submitted = true;
      document.body.setAttribute('data-submitted', 'true');
      alert('Тест отправлен. Это кнопка завершения: расширение не должно её нажимать.');
    }),
  );
});
