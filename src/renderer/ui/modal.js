// Tiny promise-based modal to stand in for window.prompt/confirm, which
// Electron renderers don't support. One instance, reused for every call.

const overlay = document.getElementById('modal-overlay');
const titleEl = document.getElementById('modal-title');
const messageEl = document.getElementById('modal-message');
const inputEl = document.getElementById('modal-input');
const okBtn = document.getElementById('modal-ok');
const cancelBtn = document.getElementById('modal-cancel');

let activeResolve = null;

function close(result) {
  overlay.classList.add('hidden');
  if (activeResolve) {
    const resolve = activeResolve;
    activeResolve = null;
    resolve(result);
  }
}

okBtn.addEventListener('click', () => close(inputEl.style.display === 'none' ? true : inputEl.value));
cancelBtn.addEventListener('click', () => close(null));
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) close(null);
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') close(inputEl.value);
  if (e.key === 'Escape') close(null);
});

/** Prompt for a text/number value. Resolves to the string, or null if cancelled. */
export function promptModal({ title, message, defaultValue = '', okLabel = 'OK', inputType = 'text' }) {
  return new Promise((resolve) => {
    activeResolve = resolve;
    titleEl.textContent = title;
    messageEl.textContent = message ?? '';
    messageEl.style.display = message ? 'block' : 'none';
    inputEl.style.display = 'block';
    inputEl.type = inputType;
    inputEl.value = defaultValue;
    okBtn.textContent = okLabel;
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => {
      inputEl.focus();
      inputEl.select();
    });
  });
}

/** Simple OK/Cancel confirmation. Resolves to true/false. */
export function confirmModal({ title, message, okLabel = 'OK' }) {
  return new Promise((resolve) => {
    activeResolve = (result) => resolve(result === true);
    titleEl.textContent = title;
    messageEl.textContent = message ?? '';
    messageEl.style.display = message ? 'block' : 'none';
    inputEl.style.display = 'none';
    okBtn.textContent = okLabel;
    overlay.classList.remove('hidden');
  });
}
