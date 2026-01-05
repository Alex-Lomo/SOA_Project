# Shopping List App – Architecture & Documentation

## Overview

This project is a distributed, containerized shopping list application built using a microservices architecture.  
It demonstrates authentication, event-driven communication, real-time updates, and horizontal scalability.

The system consists of:
- A web frontend
- An API gateway
- Multiple backend microservices
- Message brokers for async and RPC-style communication
- Supporting infrastructure services

---

## High-Level Architecture

- **Frontend (Web)**: Lit-based SPA served to the browser
- **API Service**: Central HTTP + WebSocket gateway
- **User Service**: Handles authentication and user management
- **Item Service**: Manages shopping list items
- **Mail Service**: Sends mock emails
- **PostgreSQL**: Persistent storage
- **RabbitMQ**: RPC-style communication between API and services
- **Kafka**: Event streaming between services
- **Redis**: Pub/Sub for WebSocket fan-out
- **Nginx**: Reverse proxy and load balancer
- **Docker Compose**: Orchestration

---

## C4 Diagram – System Context

```mermaid
C4Context
title Shopping List App - System Context

Person(user, "User", "Uses the shopping list application")

System_Boundary(app, "Shopping List Application") {
  System(web, "Web Frontend", "Browser-based SPA")
  System(api, "API Gateway", "HTTP + WebSocket entry point")

  System(userService, "User Service", "Authentication and users")
  System(itemService, "Item Service", "Shopping list items")
  System(mailService, "Mail Service", "Mock email sender")
}

System_Ext(db, "PostgreSQL", "Relational database")
System_Ext(rabbitmq, "RabbitMQ", "RPC messaging")
System_Ext(kafka, "Kafka", "Event streaming")
System_Ext(redis, "Redis", "WebSocket Pub/Sub")

Rel(user, web, "Uses", "HTTPS")
Rel(web, api, "API calls", "HTTP / WebSocket")

Rel(api, rabbitmq, "RPC requests")
Rel(api, redis, "Publish/Subscribe")

Rel(userService, db, "Reads/Writes")
Rel(itemService, db, "Reads/Writes")

Rel(userService, kafka, "Publishes user events")
Rel(mailService, kafka, "Consumes user events")
```

---

## Container-Level Architecture (C4 – Containers)

```mermaid
C4Container
title Shopping List App - Container Architecture

Container_Boundary(client, "Client") {
  Container(web, "Web Frontend", "Lit + JavaScript", "SPA UI")
}

Container_Boundary(edge, "Edge / Routing") {
  Container(nginx, "Nginx", "Reverse Proxy", "Traffic routing")
}

Container_Boundary(backend, "Backend") {
  Container(api, "API Gateway", "Node.js + Express", "HTTP & WebSocket API")

  Container(userService, "User Service", "Node.js", "Auth and users")
  Container(itemService, "Item Service", "Node.js", "Item management")
  Container(mailService, "Mail Service", "Node.js", "Email notifications")
}

ContainerDb(db, "PostgreSQL", "Relational database")
Container(redis, "Redis", "Pub/Sub", "WebSocket scaling")
Container(rabbitmq, "RabbitMQ", "RPC messaging")
Container(kafka, "Kafka", "Event streaming")

Rel(web, nginx, "HTTP")
Rel(nginx, api, "HTTP")

Rel(api, userService, "RPC")
Rel(api, itemService, "RPC")
Rel(api, redis, "Publish/Subscribe")

Rel(userService, rabbitmq, "Consumes RPC")
Rel(itemService, rabbitmq, "Consumes RPC")

Rel(userService, db, "SQL")
Rel(itemService, db, "SQL")

Rel(userService, kafka, "Publish events")
Rel(mailService, kafka, "Consume events")
```

---

## Component Responsibilities

### Web Frontend
- Built with Lit (Web Components)
- Handles:
  - Login / signup
  - JWT storage
  - Item creation and updates
  - WebSocket connection for real-time updates
- No business logic

### Nginx
- Reverse proxy
- Load balances requests to API replicas
- Single public entry point

### API Service
- Express-based gateway
- Handles HTTP, WebSockets, JWT verification, Redis Pub/Sub
- Stateless

### User Service
- Owns users and authentication
- PostgreSQL-backed
- Publishes user-created events to Kafka

### Item Service
- Owns shopping list items
- PostgreSQL-backed
- Horizontally scalable

### Mail Service
- Consumes Kafka events
- Sends mock emails

---

## Communication Patterns

- HTTP: Browser to API
- RabbitMQ RPC: API to services
- Kafka events: Service-to-service
- WebSockets + Redis: Real-time updates

---

## Authentication Flow

```mermaid
sequenceDiagram
User->>Web: Login / Signup
Web->>API: POST request
API->>UserService: RPC
UserService->>API: JWT
API->>Web: JWT response
```

---

## Item Update Flow

```mermaid
sequenceDiagram
User->>Web: Add item
Web->>API: POST /items
API->>ItemService: RPC
ItemService->>API: Item
API->>Redis: Publish update
API->>Web: WebSocket event
```

---

## Running the App

```bash
docker compose up --build
```

- Web UI: http://localhost:8000
- API: http://localhost
- RabbitMQ UI: http://localhost:15672

---
