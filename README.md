# lenne.Tech Monorepro

In this readme you find all information about functionality and usage of this project. It is clustered in the following sections:

## 📑 Content Table

- About the project
- Links to running systems
- Prerequisites
- Quick start for contributors
- Environment Variables
- Tech-Stack
- How to create a new db-collection
- Deployment

## 🌐 About the project

write here about the project

## 🔗 Links to running systems

The following systems are currently running:

- Dev
- Test
- Production

## ⚙️ Prerequisites

Make sure you have the following installed:

- [Node.js](https://nodejs.org/en)
- [MongoDB](https://www.mongodb.com/docs/manual/)
- [Docker](https://docs.docker.com/) (optional, but recommended for deployment)

## 🚀 Quick start for contributors

> Development system must have node installed + mongo installed and running

The project is created as a monorepo. The repository is divided in two separate sections:

- app
- api

The following steps are necessary to install everything correctly:

```bash
# Clone repository
git clone <repository-url>

# Switch to project-folder
cd <project-folder>

# Install dependencies for app and api
npm run init

# Create environment variables
cd projects/app
cp .env.example .env

# Start project
cd ../../
npm run start
```

## 🛠️ Environment Variables

You need to set up the following environment variables in the `.env` file:

| Variable         | Description                                                        | Default (.env.example)  |
| ---------------- | ------------------------------------------------------------------ | ----------------------- |
| `SITE_URL`       | Defines the base URL of the frontend application.                  | `http://127.0.0.1:3001` |
| `NODE_ENV`       | Specifies the environment in which the application is running.     | `development`           |
| `API_URL`        | Defines the base URL of the backend API.                           | `http://127.0.0.1:3000` |
| `WEB_PUSH_KEY`   | The public key used for Web Push notifications.                    | (empty)                 |
| `API_SCHEMA`     | The path to the GraphQL schema file.                               | `../api/schema.gql`     |
| `STORAGE_PREFIX` | Defines the prefix used for local storage or cache keys.           | `fc-dev`                |
| `GENERATE_TYPES` | Determines whether or not types should be automatically generated. | `0`                     |

## 🧰 Tech-Stack

This project build with modern frameworks to get a sustainable and fast experience. Following technologies, frameworks and libraries are used:

- Frontend:
  - [Vue.js](https://vuejs.org/guide/introduction.html)
  - [NUXT](https://nuxt.com/docs/getting-started/introduction)
  - [TailwindCSS](https://tailwindcss.com/docs/installation)

- Backend:
  - [Nest.js](https://docs.nestjs.com/)

- Database:
  - [MongoDB](https://www.mongodb.com/docs/manual/)

- Other:
  - [Docker](https://docs.docker.com/)

## 📂 How to create a new db-collection

> The instructions are based on the usage of [lt cli](https://www.npmjs.com/package/@lenne.tech/cli)

If you want to create a new feature with new values inside the database (for example a whole new collection), you need to follow a few steps:

1. Switch to the api folder:

```bash
cd projects/api
```

2. Create a new server module via lt cli:

```bash
# Type lt and switch to server and then module
lt

# Or type the following to get there in one step
lt server module
```

3. Follow the instructions to create the new module.

4. When you submit your creation, there will be a new folder inside your api with a few files, which are necessary for all operations, you want to do with that new collection.

5. To be able to see and use those changes inside your app, you have to generate those types. Therefore we first switch to our app:

```bash
cd projects/app
```

6. Now just type the following command:

```bash
npm run generate-types
```

7. The updated types are generated and are ready to be used inside your app.

## 🚢 Deployment

To deploy the project and use new features, you need to follow these steps:

1. Push or merge changes in the dev-branch
   > The changes automatically get deployed on the dev system
2. Push or merge changes in the test-branch
   > The changes automatically get deployed on the test system
3. Push or merge changes in the main-branch
   > The changes automatically get deployed on the production system

New deployments keep the old database. Make sure that your system might not work properly with the new features and an old db-instance
