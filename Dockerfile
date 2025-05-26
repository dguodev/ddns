# Stage 1: Build the Express.js application
# Uses a lean Node.js image for building, which helps keep the final image size down.
FROM node:20-alpine AS builder

# Set the working directory inside the container.
WORKDIR /app

# Copy package.json and package-lock.json (or yarn.lock) first.
# This optimizes Docker's layer caching, meaning 'npm install' won't rerun
# if only your application source code changes.
COPY package*.json ./

# Install production dependencies.
# Remove '--production' if you need development dependencies for some reason (e.g., build tools).
RUN npm install --production

# Copy the rest of your application code into the builder stage.
COPY . .

# Stage 2: Create the final production-ready image
# Uses the same lean Node.js image for the final runtime environment.
FROM node:20-alpine

# Set the working directory for the final image.
WORKDIR /app

# Copy only the essential files from the builder stage:
# 1. node_modules (with production dependencies)
# 2. Your application's source code
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app ./

# Expose the port your Express.js application listens on.
# Express typically uses port 3000 by default. Adjust if your app uses a different port.
EXPOSE 3000

# Define the command to run your application when the container starts.
# This assumes you have a "start" script in your package.json (e.g., "start": "node app.js").
CMD ["npm", "start"]

# Optional: Add metadata to your Docker image.
LABEL maintainer="Dan"
LABEL version="1.0.0"
LABEL description="Docker image for an cloudflare ddns updater"