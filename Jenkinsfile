pipeline {
  agent any

  environment {
    COMPOSE_DIR = '/opt/prila'
    SERVICE = 'backend'
    IMAGE = 'prila-backend'
  }

  stages {
    stage('Pull') {
      steps {
        checkout scm
        sh 'git fetch origin main && git checkout main && git pull --ff-only origin main'
      }
    }

    stage('Build') {
      steps {
        script {
          env.PREV_IMAGE_ID = sh(
            script: "docker images -q ${IMAGE}:previous || true",
            returnStdout: true
          ).trim()
          sh """
            docker tag ${IMAGE}:latest ${IMAGE}:previous || true
            docker build -t ${IMAGE}:latest .
          """
        }
      }
    }

    stage('Deploy') {
      steps {
        dir("${COMPOSE_DIR}") {
          sh "docker compose up -d --no-deps --force-recreate ${SERVICE}"
        }
      }
    }

    stage('Health') {
      steps {
        script {
          def ok = false
          for (int i = 0; i < 30; i++) {
            def code = sh(
              script: 'curl -sf -o /dev/null -w "%{http_code}" http://backend:4000/api/v1/health || true',
              returnStdout: true
            ).trim()
            if (code == '200') {
              ok = true
              break
            }
            sleep 2
          }
          if (!ok) {
            error('Backend health check failed')
          }
        }
      }
    }
  }

  post {
    failure {
      script {
        echo 'Health failed — rolling back to previous image'
        sh """
          if docker image inspect ${IMAGE}:previous >/dev/null 2>&1; then
            docker tag ${IMAGE}:previous ${IMAGE}:latest
            cd ${COMPOSE_DIR} && docker compose up -d --no-deps --force-recreate ${SERVICE}
          else
            echo 'No previous image available for rollback'
          fi
        """
      }
    }
  }
}
