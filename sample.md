# Checkout Flow

```mermaid
sequenceDiagram
  participant Customer
  participant Store
  participant Payment

  Customer->>Store: Place order
  Store->>Payment: Authorize payment
  Payment-->>Store: Authorization approved
  Store-->>Customer: Show confirmation
```
