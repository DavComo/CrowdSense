"""
surrogate.py -- a tiny neural net standing in for the real simulator, plus
gradient-based search THROUGH it.

Why a network at all: `objective()` in arena.py calls Dijkstra + flow
accumulation on a grid. Cheap here, but the REAL Navier-Stokes-flavoured
solver your teammates build will be much slower. Once it's slow, you can't
try thousands of layouts directly -- you generate a batch of (layout, score)
pairs from it overnight, train this network to imitate it, and search
against the network instead. That's the entire justification for having ML
in this project: search needs ~10,000 evaluations, physics can afford ~500.

This file is plain numpy so it runs with zero extra installs. It IS a real
neural net -- forward pass, backprop, gradient descent -- just hand-written
instead of imported.
"""

import numpy as np

# ---------------------------------------------------------------------- #
# A 2-layer MLP:  14 inputs -> 32 hidden (tanh) -> 16 hidden (tanh) -> 1
# ---------------------------------------------------------------------- #

class Surrogate:
    def __init__(self, n_in=14, h1=32, h2=16, seed=0):
        rng = np.random.default_rng(seed)
        s = lambda fan_in: np.sqrt(2.0 / fan_in)
        self.W1 = rng.normal(0, s(n_in), (n_in, h1)); self.b1 = np.zeros(h1)
        self.W2 = rng.normal(0, s(h1),   (h1, h2));    self.b2 = np.zeros(h2)
        self.W3 = rng.normal(0, s(h2),   (h2, 1));     self.b3 = np.zeros(1)
        # running input normalisation -- inputs are already in [0,1] here,
        # but this is what you'd add the moment inputs are on real units
        self.x_mean, self.x_std = 0.0, 1.0
        self.y_mean, self.y_std = 0.0, 1.0

    def _forward(self, X):
        """Returns prediction plus every intermediate value backprop needs."""
        Xn = (X - self.x_mean) / self.x_std
        z1 = Xn @ self.W1 + self.b1; a1 = np.tanh(z1)
        z2 = a1 @ self.W2 + self.b2; a2 = np.tanh(z2)
        z3 = a2 @ self.W3 + self.b3
        y  = z3 * self.y_std + self.y_mean
        return y, (Xn, a1, a2)

    def predict(self, X):
        X = np.atleast_2d(X)
        y, _ = self._forward(X)
        return y.ravel()

    def fit(self, X, y, epochs=800, lr=0.05, verbose=True):
        y = y.reshape(-1, 1)
        self.x_mean, self.x_std = X.mean(0), X.std(0) + 1e-8
        self.y_mean, self.y_std = y.mean(), y.std() + 1e-8

        n = len(X)
        for ep in range(epochs):
            pred, (Xn, a1, a2) = self._forward(X)
            err = (pred - y) / self.y_std          # dL/dz3, scaled back
            loss = float(np.mean(((pred - y) / self.y_std) ** 2))

            # ---- backprop, textbook chain rule, one layer at a time ----
            dW3 = a2.T @ err / n;              db3 = err.mean(0)
            da2 = err @ self.W3.T
            dz2 = da2 * (1 - a2 ** 2)
            dW2 = a1.T @ dz2 / n;               db2 = dz2.mean(0)
            da1 = dz2 @ self.W2.T
            dz1 = da1 * (1 - a1 ** 2)
            dW1 = Xn.T @ dz1 / n;               db1 = dz1.mean(0)

            for p, g in [(self.W3,dW3),(self.b3,db3),(self.W2,dW2),
                         (self.b2,db2),(self.W1,dW1),(self.b1,db1)]:
                p -= lr * g

            if verbose and ep % 200 == 0:
                print(f"    epoch {ep:4d}   train MSE {loss:.4f}")

    def grad_wrt_input(self, x):
        """dPrediction/dx -- the gradient the optimiser climbs down. This is
        the payoff for hand-writing backprop: getting this is three more
        lines, same chain rule, just stopped one layer earlier."""
        x = x.reshape(1, -1)
        y, (Xn, a1, a2) = self._forward(x)
        dz3 = np.array([[1.0]]) * self.y_std
        da2 = dz3 @ self.W3.T
        dz2 = da2 * (1 - a2 ** 2)
        da1 = dz2 @ self.W2.T
        dz1 = da1 * (1 - a1 ** 2)
        dXn = dz1 @ self.W1.T
        return (dXn / self.x_std).ravel()


def gradient_search(surrogate, x0, steps=300, lr=0.02):
    """Walk DOWNHILL on the surrogate's prediction, staying in [0,1]^14
    because that's the space where unpack() guarantees a legal venue."""
    x = np.clip(x0.copy(), 0, 1)
    for _ in range(steps):
        g = surrogate.grad_wrt_input(x)
        x = np.clip(x - lr * g, 0, 1)
    return x
