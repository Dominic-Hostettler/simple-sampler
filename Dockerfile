FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY static ./static
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /server .

FROM scratch
COPY --from=build /server /server
USER 65534:65534
EXPOSE 9090
ENTRYPOINT ["/server"]
