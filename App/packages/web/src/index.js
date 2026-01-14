import { LitElement, html, css } from 'lit';

class ShoppingList extends LitElement {
  static styles = css`
    * {
      box-sizing: border-box;
    }

    :host {
      display: block;
      width: 100%;
      margin: 24px auto;
      font-family: Arial, sans-serif;
      color: #333;
    }

    h2 {
      margin-bottom: 16px;
    }

    form {
      display: grid;
      grid-template-columns: 2fr 3fr 1fr 1fr auto;
      gap: 8px;
      margin-bottom: 24px;
      width: 100%;
    }

    input[type="text"],
    input[type="number"] {
      padding: 8px;
      border-radius: 4px;
      border: 1px solid #ccc;
      width: 100%;
    }

    button {
      padding: 8px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      background-color: #007bff;
      color: white;
      white-space: nowrap;
    }

    button.delete {
      background-color: #dc3545;
    }

    ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    li {
      background: #f9f9f9;
      border: 1px solid #ddd;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      flex-wrap: wrap;
    }

    li.bought {
      background-color: #eeeeee;
      opacity: 0.7;
    }

    .item-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 70%;
      word-break: break-word;
    }

    .item-info.bought {
      color: #999;
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Disable everything except delete button when bought */
    li.bought .item-info,
    li.bought input[type="checkbox"] {
      pointer-events: none;
    }
  `;

  static properties = {
    items: { type: Array },
    isAuthenticated: { type: Boolean },
  };

  constructor() {
    super();
    this.items = [];
    this.isAuthenticated = false;
    this.socket = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.checkAuth();
  }

  checkAuth() {
    const token = localStorage.getItem('jwt_token');
    if (token) {
      this.isAuthenticated = true;
      this.fetchItems();
      this.connectWebSocket();
      this.showAppContent();
    } else {
      this.isAuthenticated = false;
      this.showAuthForms();
    }
  }

  showAppContent() {
    document.getElementById('auth-forms').style.display = 'none';
    document.getElementById('app-content').style.display = 'block';
  }

  showAuthForms() {
    document.getElementById('auth-forms').style.display = 'block';
    document.getElementById('app-content').style.display = 'none';
  }

  connectWebSocket() {
    if (this.socket) return;

    const token = localStorage.getItem('jwt_token');
    if (!token) return;

    this.socket = new WebSocket(`ws://localhost?token=${token}`);

    this.socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'item_added') {
        this.items = [...this.items, msg.item];
      }

      if (msg.type === 'item_updated') {
        this.items = this.items.map(i =>
          i.id === msg.item.id ? msg.item : i
        );
      }

      if (msg.type === 'item_deleted') {
        this.items = this.items.filter(i => i.id !== msg.id);
      }
    });
  }

  async fetchItems() {
    const token = localStorage.getItem('jwt_token');
    if (!token) return;

    const response = await fetch('http://localhost/items', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok) {
      this.items = await response.json();
    } else {
      this.handleLogout();
    }
  }

  async addItem(e) {
    e.preventDefault();
    const token = localStorage.getItem('jwt_token');
    if (!token) return;

    const form = e.target;
    const item = {
      name: form.name.value,
      description: form.description.value,
      price: parseFloat(form.price.value),
      quantity: parseInt(form.quantity.value),
    };

    const response = await fetch('http://localhost/items', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(item),
    });

    if (response.ok) {
      const newItem = await response.json();
      this.items = [...this.items, newItem];
      form.reset();
    }
  }

  async toggleBought(item) {
    const token = localStorage.getItem('jwt_token');

    this.items = this.items.map(i =>
      i.id === item.id ? { ...i, bought: !i.bought } : i
    );

    await fetch(`http://localhost/items/${item.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ bought: !item.bought }),
    });
  }

  async deleteItem(item) {
    const token = localStorage.getItem('jwt_token');

    await fetch(`http://localhost/items/${item.id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    this.items = this.items.filter(i => i.id !== item.id);
  }

  handleLogout() {
    localStorage.removeItem('jwt_token');
    this.items = [];
    this.isAuthenticated = false;
    if (this.socket) this.socket.close();
    this.showAuthForms();
  }

  render() {
    if (!this.isAuthenticated) return html``;

    return html`
      <h2>Shopping List</h2>

      <form @submit=${this.addItem}>
        <input name="name" placeholder="Name" required />
        <input name="description" placeholder="Description" />
        <input name="price" type="number" step="0.01" placeholder="Price" required />
        <input name="quantity" type="number" min="1" placeholder="Qty" required />
        <button type="submit">Add</button>
      </form>

      <ul>
        ${this.items.map(
          (item) => html`
            <li class=${item.bought ? 'bought' : ''}>
              <div class="item-info ${item.bought ? 'bought' : ''}">
                <strong>${item.name}</strong>
                <span>${item.description || ''}</span>
                <span>$${item.price} × ${item.quantity}</span>
              </div>

              <div class="actions">
                <input
                  type="checkbox"
                  .checked=${item.bought}
                  @change=${() => this.toggleBought(item)}
                />

                ${item.bought
                  ? html`
                      <button
                        class="delete"
                        @click=${() => this.deleteItem(item)}
                      >
                        Remove
                      </button>
                    `
                  : null}
              </div>
            </li>
          `
        )}
      </ul>
    `;
  }
}

customElements.define('shopping-list', ShoppingList);
